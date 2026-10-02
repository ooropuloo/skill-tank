# stop the skill-tank server (only the node process listening on 4700 running server.mjs)
$port = if ($env:SKILL_TANK_PORT) { [int]$env:SKILL_TANK_PORT } else { 4700 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "skill-tank: nothing listening on $port"; exit 0 }
foreach ($c in $conns) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  if ($p.CommandLine -like '*server.mjs*') { Stop-Process -Id $p.ProcessId -Force; Write-Host "skill-tank: stopped PID $($p.ProcessId)" }
  else { Write-Host "skill-tank: port $port is used by another program, not touching: $($p.CommandLine)" }
}
