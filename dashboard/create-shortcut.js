// Puts a "Call Dashboard" icon on your Windows desktop. Double-clicking it
// starts the dashboard and opens it in your browser, no terminal needed.
//
// Usage (once): npm run dashboard:shortcut

const { execFileSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "win32") {
  console.error("This creates a Windows desktop shortcut. On macOS or Linux, run: npm run dashboard");
  process.exit(1);
}

const launcher = path.join(__dirname, "Call Dashboard.cmd");
const icon = path.join(__dirname, "phone.ico");
const quote = (s) => `'${s.replace(/'/g, "''")}'`;

const script = `
$desktop = [Environment]::GetFolderPath('Desktop')
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Call Dashboard.lnk'))
$link.TargetPath = ${quote(launcher)}
$link.WorkingDirectory = ${quote(path.dirname(__dirname))}
$link.IconLocation = ${quote(icon)}
$link.WindowStyle = 7
$link.Description = 'Screened calls dashboard'
$link.Save()
Write-Output (Join-Path $desktop 'Call Dashboard.lnk')
`;

const created = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
  encoding: "utf8",
}).trim();
console.log(`Created ${created}. Double-click it to open the dashboard.`);
