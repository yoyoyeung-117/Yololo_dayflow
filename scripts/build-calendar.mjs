import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') { console.log('Apple Calendar helper requires macOS.'); process.exit(0); }
const root = path.resolve('.local/Dayflow Calendar.app');
fs.mkdirSync(path.join(root, 'Contents/MacOS'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(root, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.dayflow.calendar</string><key>CFBundleName</key><string>Dayflow Calendar</string>
<key>CFBundleExecutable</key><string>DayflowCalendar</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
<key>NSCalendarsFullAccessUsageDescription</key><string>Dayflow reads your day to suggest schedule changes and saves only the changes you approve.</string>
<key>NSCalendarsUsageDescription</key><string>Dayflow reads your day and saves approved schedule changes.</string>
</dict></plist>`);
for (const [cmd, args] of [
  ['xcrun', ['swiftc', '-O', 'native/CalendarBridge.swift', '-o', path.join(root, 'Contents/MacOS/DayflowCalendar'), '-framework', 'EventKit', '-framework', 'AppKit', '-framework', 'MapKit']],
  ['codesign', ['--force', '--sign', '-', '--identifier', 'local.dayflow.calendar', root]],
]) { const result = spawnSync(cmd, args, { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1); }
console.log('Built Dayflow Calendar helper.');
