$sep = '$$'
$arg = Read-Host
# commandString{open, add, rg} pwd pipedInput > pipeName
"`"$($args[0]) $sep $(Get-Location) $sep $arg`"" | Out-File -FilePath $args[1] -Encoding utf8