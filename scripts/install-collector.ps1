# Windows PowerShell 5.1 / PowerShell 7. Current user only; no elevation or passwords.
[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [switch]$PlanOnly,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$statePath = Join-Path $workspace '.local/collector-task.json'
$taskName = 'FavoriteSongSurvey-PCMirror-' + ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value.Replace('-', '_'))

function Assert-InWorkspace([string]$Candidate, [switch]$MustExist) {
    if (-not [IO.Path]::IsPathRooted($Candidate)) { throw 'Expected an absolute path' }
    $absolute = [IO.Path]::GetFullPath($Candidate)
    if (-not $absolute.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path is outside intended workspace'
    }
    if ($absolute.Contains('"') -or $absolute.Contains("`r") -or $absolute.Contains("`n")) { throw 'Unsupported path characters' }
    if ($MustExist -and -not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw 'Required project file unavailable' }
    return $absolute
}

try {
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $workspace '.local/collector.json' }
    if ($Uninstall) {
        if (-not (Test-Path -LiteralPath $statePath)) { throw 'No owned collector task metadata found' }
        $owned = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owned.task_name -ne $taskName -or $owned.workspace -ne $workspace) { throw 'Task metadata does not match this user/workspace' }
        if (-not $PlanOnly) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
            Remove-Item -LiteralPath $statePath -Force
        }
        @{ task_name = $taskName; uninstalled = (-not $PlanOnly) } | ConvertTo-Json -Compress
        exit 0
    }
    $config = Assert-InWorkspace $ConfigPath -MustExist
    $script = Assert-InWorkspace (Join-Path $workspace 'collector/mirror.py') -MustExist
    $launcher = Assert-InWorkspace (Join-Path $workspace 'scripts/setup-run-collector.ps1') -MustExist
    $settings = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
    $database = Assert-InWorkspace $settings.database
    $backups = Assert-InWorkspace $settings.backups
    if (-not $settings.sync_token -or -not $settings.api_base -or -not $settings.collector_id) { throw 'Collector private configuration incomplete' }
    $python = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $python = [IO.Path]::GetFullPath($python)
    $pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
    if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'pythonw.exe not found next to installed Python' }
    $version = & $python -c 'import sys; print(int(sys.version_info >= (3,11)))'
    if ($LASTEXITCODE -ne 0 -or $version -ne '1') { throw 'Python 3.11 or newer required' }
    # Validate URL/config with actual collector code, never print token or JSON.
    & $python -c 'import sys; sys.path.insert(0, sys.argv[1]); from mirror import load_config; load_config(sys.argv[2])' (Split-Path -Parent $script) $config 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Collector configuration validation failed (private details redacted)' }
    $shell = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $shell)) { $shell = Join-Path $PSHOME 'pwsh.exe' }
    if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { throw 'PowerShell executable unavailable' }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -PythonwPath "' + $pythonw + '" -ScriptPath "' + $script + '" -ConfigPath "' + $config + '"'
    $escape = { param($value) [Security.SecurityElement]::Escape($value) }
    $start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Favorite song survey read-only PC mirror; current user only</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$start</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Hidden>true</Hidden><ExecutionTimeLimit>PT15M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$(& $escape $shell)</Command><Arguments>$(& $escape $arguments)</Arguments><WorkingDirectory>$(& $escape $workspace)</WorkingDirectory></Exec></Actions>
</Task>
"@
    if ($PlanOnly) {
        @{ task_name = $taskName; registered = $false; xml = $xml } | ConvertTo-Json -Compress
        exit 0
    }
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        if (-not (Test-Path -LiteralPath $statePath)) { throw 'Task already exists without owned metadata; refusing overwrite' }
        $owned = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owned.workspace -ne $workspace -or $owned.task_name -ne $taskName) { throw 'Existing task belongs to another workspace' }
    }
    Register-ScheduledTask -TaskName $taskName -Xml $xml -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
    @{ task_name = $taskName; workspace = $workspace; user = $user } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    @{ task_name = $taskName; registered = $true } | ConvertTo-Json -Compress
    exit 0
} catch {
    # Only locally authored path/config failures or sanitized OS rights errors.
    $safe = $_.Exception.Message
    if ($safe -notmatch '^(Path is outside intended workspace|Expected an absolute path|Unsupported path characters|Required project file unavailable|Collector private configuration incomplete|Collector configuration validation failed|pythonw.exe not found|Python 3.11|PowerShell executable unavailable|No owned collector|Task metadata|Task already exists|Existing task belongs)') {
        $safe = 'Current-user scheduled task registration failed; OS access rights or executable availability must be checked. No elevation attempted.'
    }
    [Console]::Error.WriteLine($safe)
    exit 1
}
