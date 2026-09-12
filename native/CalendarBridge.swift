import Foundation
import AppKit
import EventKit
import CryptoKit
import MapKit

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
    var row: [String: Any] = ["id": identifier + "@" + String(Int64(ms(event.startDate))), "eventIdentifier": identifier,
            "calendarId": event.calendar.calendarIdentifier, "calendarName": event.calendar.title,
            "title": event.title ?? "Untitled event", "start": ms(event.startDate), "end": ms(event.endDate),
            "allDay": event.isAllDay, "editable": editable(event), "hasAttendees": event.hasAttendees || event.organizer != nil,
            "recurring": event.hasRecurrenceRules, "location": event.location ?? "", "modified": event.lastModifiedDate.map(ms) ?? 0,
            "busy": event.availability != .free && event.status != .canceled]
    if let coordinate = event.structuredLocation?.geoLocation?.coordinate {
        row["coordinates"] = ["latitude": coordinate.latitude, "longitude": coordinate.longitude]
    }
    // Return only the meeting link, never the full private event notes.
    let text = [event.url?.absoluteString ?? "", event.location ?? "", event.notes ?? ""].joined(separator: "\n")
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    let links = detector?.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { $0.url } ?? []
    let domains = ["zoom.us", "zoom.com", "meet.google.com", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "webex.com", "whereby.com", "meet.jit.si"]
    if let url = links.first(where: { url in
        guard url.scheme == "https", url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return false }
        return domains.contains { host == $0 || host.hasSuffix("." + $0) }
    }) { row["joinUrl"] = url.absoluteString; row["online"] = true }
    else { row["online"] = (event.location ?? "").range(of: #"(?i)\b(online|virtual|zoom|google meet|microsoft teams)\b|線上|线上|網上"#, options: .regularExpression) != nil }
    return row
}
@Sendable func revision(_ events: [[String: Any]]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: events, options: [.sortedKeys])
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
// MapKit resolves actual places and routes. No estimated speeds or seeded locations.
func resolvePlace(_ input: [String: Any], completion: @escaping (MKMapItem?) -> Void) {
    if let lat = input["latitude"] as? Double, let lon = input["longitude"] as? Double,
       lat.isFinite, lon.isFinite, abs(lat) <= 90, abs(lon) <= 180 {
        completion(MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon))))
        return
    }
    guard let address = input["address"] as? String, !address.isEmpty else { completion(nil); return }
    let request = MKLocalSearch.Request(); request.naturalLanguageQuery = address
    let search = MKLocalSearch(request: request)
    search.start { response, _ in
        _ = search
        completion(response?.mapItems.first)
    }
}
func route(_ request: [String: Any]) {
    guard let origin = request["origin"] as? [String: Any], let destination = request["destination"] as? [String: Any] else { fail("A current location and event venue are required.") }
    resolvePlace(origin) { from in
        guard let from = from else { fail("Apple Maps could not find your starting address. Enter a full street address or use your location.") }
        resolvePlace(destination) { to in
            guard let to = to else { fail("Apple Maps could not find the calendar venue. Add a full address in Apple Calendar.") }
            let query = MKDirections.Request(); query.source = from; query.destination = to
            query.transportType = request["mode"] as? String == "walking" ? .walking : .automobile
            query.departureDate = Date()
            let directions = MKDirections(request: query)
            directions.calculate { response, error in
                _ = directions
                guard let route = response?.routes.first else { fail("Apple Maps could not calculate this route. Check the addresses or try another travel mode.") }
                let a = from.placemark.coordinate, b = to.placemark.coordinate
                var result: [String: Any] = ["ok": true, "seconds": route.expectedTravelTime, "meters": route.distance,
                    "origin": ["latitude": a.latitude, "longitude": a.longitude], "destination": ["latitude": b.latitude, "longitude": b.longitude], "provider": "Apple Maps", "originName": from.name ?? "Starting coordinates", "destinationName": to.name ?? "Calendar coordinates"]
                let options = MKMapSnapshotter.Options()
                options.size = NSSize(width: 900, height: 360)
                options.mapRect = route.polyline.boundingMapRect.insetBy(dx: -max(route.polyline.boundingMapRect.width * 0.2, 1500), dy: -max(route.polyline.boundingMapRect.height * 0.3, 1500))
                let snapshotter = MKMapSnapshotter(options: options)
                snapshotter.start { snapshot, _ in
                    _ = snapshotter
                    if let snapshot = snapshot {
                        let image = NSImage(size: options.size)
                        image.lockFocus(); snapshot.image.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
                        let line = NSBezierPath(); line.lineWidth = 5; line.lineJoinStyle = .round; NSColor.systemBlue.setStroke()
                        let points = route.polyline.points()
                        for i in 0..<route.polyline.pointCount { let point = snapshot.point(for: points[i].coordinate); if i == 0 { line.move(to: point) } else { line.line(to: point) } }
                        line.stroke()
                        for (coordinate, color) in [(a, NSColor.systemGreen), (b, NSColor.systemRed)] {
                            let point = snapshot.point(for: coordinate); color.setFill()
                            NSBezierPath(ovalIn: NSRect(x: point.x - 6, y: point.y - 6, width: 12, height: 12)).fill()
                        }
                        image.unlockFocus()
                        if let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) { result["mapImage"] = "data:image/png;base64," + png.base64EncodedString() }
                    }
                    finish(result)
                }
            }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 45) { fail("Apple Maps timed out. Try refreshing the route.") }
    app.run()
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
            guard newStart >= Date(), (newStart >= event.startDate || (request["allowEarlier"] as? Bool == true && newStart >= start)), newEnd <= end, newEnd > newStart,
                  abs(newEnd.timeIntervalSince(newStart) - event.endDate.timeIntervalSince(event.startDate)) < 1 else { throw BridgeError(message: "Calendar changes must preserve duration, move future events within the approved day, and stay within this day.") }
            staged.append((event, id, newStart, newEnd))
        }
        let buffer = (request["bufferMinutes"] as? Double ?? 0) * 60
        guard buffer >= 0 && buffer <= 3600 else { throw BridgeError(message: "Invalid transition buffer.") }
        for (event, _, newStart, newEnd) in staged {
            for other in events where other !== event && (!other.isAllDay || request["allowEarlier"] as? Bool == true) && other.availability != .free && other.status != .canceled {
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
    if request["action"] as? String == "route" { route(request); exit(0) }
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
