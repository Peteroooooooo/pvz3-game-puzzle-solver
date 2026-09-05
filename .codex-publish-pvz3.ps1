$ErrorActionPreference = 'Stop'

$repoDir = 'D:\Desktop\Projects\Individual Projects - Github repository\PVZ3 tools'
$repoName = 'pvz3-tools'
$owner = 'Peteroooooooo'
$fullName = "$owner/$repoName"
$description = 'PVZ3 tools: refill-aware water sort solver and decode helper'

Set-Location $repoDir

if (-not (Test-Path -LiteralPath '.git')) {
  git init -b main | Out-Null
}

git add . | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'Initial PVZ3 tools release' | Out-Null
}

$repoExists = $false
gh repo view $fullName *> $null
if ($LASTEXITCODE -eq 0) {
  $repoExists = $true
}

if (-not $repoExists) {
  gh repo create $repoName --public --source . --remote origin --push --description $description
} else {
  try {
    git remote get-url origin | Out-Null
  } catch {
    git remote add origin "https://github.com/$fullName.git"
  }

  git branch -M main
  git push -u origin main
}

gh repo edit $fullName --description $description --add-topic pvz3 --add-topic water-sort --add-topic water-sort-solver --add-topic 'plants-vs-zombies-3' --add-topic a-star --add-topic solver --add-topic html
