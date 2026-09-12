import Foundation
import AppKit
import EventKit
import CryptoKit

struct BridgeError: Error { let message: String }
let store = EKEventStore()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let args = CommandLine.arguments
func argument(_ key: String) -> String? { guard let i = args.firstIndex(of: key), i + 1 < args.count else { return nil }; return args[i + 1] }
guard let requestPath = argument("--request"), let responsePath = argument("--response") else { exit(1) }
@Sendable func finish(_ value: [String: Any]) -> Never {
    do { let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); try data.write(to: URL(fileURLWithPath: responsePath), options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: responsePath) } catch {}
    exit(0)
}
func fail(_ message: String) -> Never { finish(["ok": false, "error": message]) }
@Sendable func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
@Sendable func editable(_ event: EKEvent) -> Bool { event.calendar.allowsContentModifications && !event.isAllDay && !event.hasAttendees && event.organizer == nil }
@Sendable func eventJSON(_ event: EKEvent) -> [String: Any] {
    let identifier = event.eventIdentifier ?? event.calendarItemIdentifier
    return ["id": identifier + "@" + String(Int64(ms(event.startDate))), "eventIdentifier": identifier,
            "calendarId": event.calendar.calendarIdentifier, "calendarName": event.calendar.title,
            "title": event.title ?? "Untitled event", "start": ms(event.startDate), "end": ms(event.endDate),
            "allDay": event.isAllDay, "editable": editable(event), "hasAttendees": event.hasAttendees || event.organizer != nil,
            "recurring": event.hasRecurrenceRules, "location": event.location ?? "", "modified": event.lastModifiedDate.map(ms) ?? 0,
            "busy": event.availability != .free && event.status != .canceled]
}
@Sendable func revision(_ events: [[String: Any]]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: events, options: [.sortedKeys])
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func execute(_ request: [String: Any]) throws {
    let action = request["action"] as? String ?? "read"
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw BridgeError(message: "Calendar access is not enabled. In System Settings → Privacy & Security → Calendars, allow full access for Dayflow Calendar.") }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone.current; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
    guard let dayString = request["day"] as? String, let date = formatter.date(from: dayString) else { throw BridgeError(message: "A valid calendar date is required.") }
    let start = Calendar.current.startOfDay(for: date), end = Calendar.current.date(byAdding: .day, value: 1, to: start)!
    let requestedIds = request["calendarIds"] as? [String] ?? []
    let calendars = store.calendars(for: .event)
    let selected = requestedIds.isEmpty ? calendars : calendars.filter { requestedIds.contains($0.calendarIdentifier) }
    if !requestedIds.isEmpty && selected.count != Set(requestedIds).count { throw BridgeError(message: "A selected calendar is no longer available. Reconnect and select your calendars again.") }
    let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: selected)).sorted { a, b in a.startDate == b.startDate ? (a.eventIdentifier ?? "") < (b.eventIdentifier ?? "") : a.startDate < b.startDate }
    let rows = events.map(eventJSON), version = try revision(rows)
    if action == "apply" {
        guard request["revision"] as? String == version else { throw BridgeError(message: "Your calendar changed since this plan was reviewed. Refresh and build a new plan.") }
        guard let changes = request["changes"] as? [[String: Any]], !changes.isEmpty, changes.count <= 8 else { throw BridgeError(message: "Choose between one and eight calendar changes.") }
        var staged: [(EKEvent, String, Date, Date)] = []
        var seen = Set<String>()
        for change in changes {
            guard let id = change["id"] as? String, seen.insert(id).inserted,
                  let event = events.first(where: { eventJSON($0)["id"] as? String == id }), editable(event),
                  let from = change["start"] as? Double, let to = change["end"] as? Double else { throw BridgeError(message: "An event cannot be edited safely. Refresh the plan.") }
            let newStart = Date(timeIntervalSince1970: from / 1000), newEnd = Date(timeIntervalSince1970: to / 1000)
            guard newStart >= Date(), newStart >= event.startDate, newEnd <= end, newEnd > newStart,
                  abs(newEnd.timeIntervalSince(newStart) - event.endDate.timeIntervalSince(event.startDate)) < 1 else { throw BridgeError(message: "Calendar changes must preserve duration, postpone future events, and stay within this day.") }
            staged.append((event, id, newStart, newEnd))
        }
        let buffer = (request["bufferMinutes"] as? Double ?? 0) * 60
        guard buffer >= 0 && buffer <= 3600 else { throw BridgeError(message: "Invalid transition buffer.") }
        for (event, _, newStart, newEnd) in staged {
            for other in events where other !== event && !other.isAllDay && other.availability != .free && other.status != .canceled {
                let replacement = staged.first { $0.0 === other }
                let otherStart = replacement?.2 ?? other.startDate!, otherEnd = replacement?.3 ?? other.endDate!
                if newStart < otherEnd.addingTimeInterval(buffer) && newEnd.addingTimeInterval(buffer) > otherStart {
                    throw BridgeError(message: "A proposed time overlaps another event or its transition buffer. Refresh and review a new plan.")
                }
            }
        }
        // Verify everything before staging. Only this occurrence of a recurring event is changed.
        for (event, _, newStart, newEnd) in staged { event.startDate = newStart; event.endDate = newEnd; try store.save(event, span: .thisEvent, commit: false) }
        do { try store.commit() } catch { fail("Calendar save could not be confirmed. Inspect Calendar before trying again; Dayflow will not automatically retry.") }
        finish(["ok": true, "receipts": staged.map { event, id, from, to in ["id": id, "eventIdentifier": event.eventIdentifier ?? "", "start": ms(from), "end": ms(to)] as [String: Any] }])
    }
    guard action == "read" || action == "connect" else { throw BridgeError(message: "Unknown calendar operation.") }
    finish(["ok": true, "day": dayString, "dayStart": ms(start), "dayEnd": ms(end), "timezone": TimeZone.current.identifier,
            "revision": version, "events": rows,
            "calendars": calendars.map { ["id": $0.calendarIdentifier, "name": $0.title, "source": $0.source.title, "writable": $0.allowsContentModifications] as [String: Any] }])
}
do {
    let request = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: requestPath))) as? [String: Any] ?? [:]
    if request["action"] as? String == "connect", EKEventStore.authorizationStatus(for: .event) == .notDetermined {
        store.requestFullAccessToEvents { granted, _ in
            DispatchQueue.main.async {
                guard granted else { fail("Calendar permission was not granted. Enable Dayflow Calendar in System Settings → Privacy & Security → Calendars.") }
                do { try execute(request) } catch let error as BridgeError { fail(error.message) } catch { fail("The Calendar operation failed. Refresh and try again.") }
            }
        }
        app.run()
    } else { try execute(request) }
} catch let error as BridgeError { fail(error.message) }
catch { fail("The Calendar request could not be read or completed.") }
