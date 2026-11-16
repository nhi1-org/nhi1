# Prompts for the Supabase secrets in the terminal (input hidden) and writes .env (gitignored).
# Values never appear on screen, in chat, or in the repo.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Ask($name) {
  $s = Read-Host -AsSecureString "$name"
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$tok = Ask 'SUPABASE_ACCESS_TOKEN (sbp_...)'
$pw  = Ask 'SUPABASE_DB_PASSWORD'
$an  = Ask 'SUPABASE_ANON_KEY (eyJ... or sb_publishable_...)'
$lines = @(
  "SUPABASE_ACCESS_TOKEN=$tok",
  "SUPABASE_DB_PASSWORD=$pw",
  "SUPABASE_ANON_KEY=$an",
  "SUPABASE_PROJECT_REF=hjrnskmovwjtaifidldw"
)
[IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), ($lines -join "`n") + "`n")
Write-Host ".env written: token len=$($tok.Length) pw len=$($pw.Length) anon len=$($an.Length)"
