[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PythonwPath,
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
try {
    $workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    foreach ($candidate in @($ScriptPath, $ConfigPath)) {
        $absolute = [IO.Path]::GetFullPath($candidate)
        if (-not [IO.Path]::IsPathRooted($candidate) -or -not $absolute.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $absolute -PathType Leaf) -or $absolute.Contains('"')) { throw 'Invalid project path' }
    }
    if (-not [IO.Path]::IsPathRooted($PythonwPath) -or -not (Test-Path -LiteralPath $PythonwPath -PathType Leaf) -or [IO.Path]::GetFileName($PythonwPath) -ne 'pythonw.exe') { throw 'Invalid Python executable' }
    $private = Join-Path $workspace '.local'
    New-Item -ItemType Directory -Path $private -Force | Out-Null
    $argsText = '"' + $ScriptPath + '" once --config "' + $ConfigPath + '"'
    $process = Start-Process -FilePath $PythonwPath -ArgumentList $argsText -WindowStyle Hidden -WorkingDirectory $workspace -Wait -PassThru -RedirectStandardOutput (Join-Path $private 'collector-last.stdout') -RedirectStandardError (Join-Path $private 'collector-last.stderr')
    exit $process.ExitCode
} catch {
    [Console]::Error.WriteLine('Collector background launch failed; private details redacted')
    exit 1
}
