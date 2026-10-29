<#
.SYNOPSIS
  Publishes a release with the version from version.txt.

.DESCRIPTION
  1. Reads the version from version.txt and copies it into package.json / package-lock.json.
  2. Runs the unit tests.
  3. Commits the version files on main (if they changed) and pushes main.
  4. Creates the tag v<version> and pushes it; the tag starts the GitHub release workflow
     (Windows x64 + macOS arm64 builds, GitHub release).

  Edit version.txt first, e.g. 0.2.0. Other uncommitted changes stop the script.

.EXAMPLE
  .\release.ps1            # asks before pushing
  .\release.ps1 -DryRun    # shows what would happen, changes nothing
  .\release.ps1 -Yes       # no question
#>
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Runs a native command; in -DryRun only commands that change something are skipped.
function Run([string]$exe, [string[]]$cmdArgs, [switch]$Changes) {
  Write-Host "> $exe $($cmdArgs -join ' ')" -ForegroundColor DarkGray
  if ($DryRun -and $Changes) { return }
  & $exe @cmdArgs
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($cmdArgs -join ' ') failed (exit code $LASTEXITCODE)" }
}

function GitOut([string[]]$gitArgs) {
  $out = & git @gitArgs 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return $out
}

# --- version ---
if (-not (Test-Path version.txt)) { Fail 'version.txt not found' }
$version = (Get-Content version.txt -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail "version.txt must contain a version like 1.2.3 (found '$version')" }
$tag = "v$version"
Write-Host "Release $tag" -ForegroundColor Cyan

# --- repository state ---
$branch = GitOut @('rev-parse', '--abbrev-ref', 'HEAD')
if ($branch -ne 'main') { Fail "releases are made from main (current branch: $branch)" }

Run git @('fetch', '--quiet', 'origin')
$behind = GitOut @('rev-list', '--count', 'HEAD..origin/main')
if ([int]$behind -gt 0) { Fail "main is $behind commit(s) behind origin/main - pull first" }

if (GitOut @('tag', '--list', $tag)) { Fail "tag $tag already exists - raise the version in version.txt" }
if (GitOut @('ls-remote', '--tags', 'origin', "refs/tags/$tag")) { Fail "tag $tag already exists on GitHub" }

$allowed = @('version.txt', 'package.json', 'package-lock.json')
$dirty = @(GitOut @('status', '--porcelain', '--untracked-files=no') | ForEach-Object { $_.Substring(3).Trim('"') } | Where-Object { $allowed -notcontains $_ })
if ($dirty.Count) { Fail "uncommitted changes besides the version files: $($dirty -join ', ') - commit or stash them first" }

# --- version into package.json, tests ---
Run node @('scripts/version.js') -Changes
if (-not $SkipTests) { Run npm @('test', '--silent') }

# --- commit, push, tag ---
Run git @('add', '--', 'version.txt', 'package.json', 'package-lock.json') -Changes
$staged = GitOut @('diff', '--cached', '--name-only')
if ($DryRun -or $staged) {
  Run git @('commit', '-m', "Release $tag") -Changes
} else {
  Write-Host 'Version files unchanged, nothing to commit.'
}

if (-not $Yes -and -not $DryRun) {
  $answer = Read-Host "Push main and tag $tag to GitHub? This starts the release build. [y/N]"
  if ($answer -notmatch '^(y|yes|j|ja)$') { Write-Host 'Stopped. The local commit (if any) is kept; nothing was pushed.'; exit 0 }
}

Run git @('push', 'origin', 'main') -Changes
Run git @('tag', '-a', $tag, '-m', "Agent Terminal Manager $version") -Changes
Run git @('push', 'origin', $tag) -Changes

$remote = GitOut @('remote', 'get-url', 'origin')
$repo = if ($remote -match 'github\.com[:/](.+?)(\.git)?$') { $Matches[1] } else { $null }
if ($DryRun) {
  Write-Host "Dry run: nothing was changed." -ForegroundColor Yellow
} else {
  Write-Host "Tag $tag pushed. The release build is running:" -ForegroundColor Green
  if ($repo) { Write-Host "  https://github.com/$repo/actions" }
}
