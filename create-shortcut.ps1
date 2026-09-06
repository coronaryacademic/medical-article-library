$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectDir 'launch-windows.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortPathBuffer = New-Object System.Text.StringBuilder 1024
Add-Type @'
using System.Text;
using System.Runtime.InteropServices;
public static class ShortcutPathHelper {
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, int bufferLength);
}
'@
$shortPathLength = [ShortcutPathHelper]::GetShortPathName($desktop, $shortPathBuffer, $shortPathBuffer.Capacity)
$shortcutDirectory = if ($shortPathLength -gt 0) { $shortPathBuffer.ToString() } else { $desktop }
$shortcutPath = Join-Path $shortcutDirectory 'UW Medical Article Library.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectDir
$shortcut.Description = 'Launch UW Medical Article Library'
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"