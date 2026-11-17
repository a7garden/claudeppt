// 가져온 PPTX 의 원본 쪽 그림 — PowerPoint 가 깔려 있으면 쪽마다 PNG 로 뽑아 source/pages/ 에 둔다.
// 웹으로 옮긴 슬라이드가 원본과 다른 곳을 Claude 가 이 그림과 견주어 고친다 (Read 도구는 그림을 본다).
// PowerPoint 가 없으면 조용히 건너뛴다 — 변환은 이 그림 없이도 된다.

use crate::{Res, err};

#[tauri::command]
pub async fn ppt_snapshot(pptx: String, out_dir: String, width: u32, height: u32) -> Res<u32> {
	tokio::task::spawn_blocking(move || {
		std::fs::create_dir_all(&out_dir).map_err(err)?;
		let q = |s: &str| s.replace('\'', "''");
		// 이미 켜 둔 PowerPoint 를 끄지 않는다 — 우리가 연 파일만 닫고, 열린 프레젠테이션이 없을 때만 끈다.
		let script = format!(
			"$ErrorActionPreference='Stop';\
			 $pp = New-Object -ComObject PowerPoint.Application;\
			 $p = $pp.Presentations.Open('{src}', $true, $false, $false);\
			 $i = 1; foreach ($s in $p.Slides) {{ $s.Export((Join-Path '{out}' ($i.ToString() + '.png')), 'PNG', {width}, {height}); $i++ }};\
			 $p.Close(); if ($pp.Presentations.Count -eq 0) {{ $pp.Quit() }}; Write-Output ($i - 1)",
			src = q(&pptx),
			out = q(&out_dir),
		);
		let mut c = std::process::Command::new("powershell");
		crate::hidden(&mut c);
		let o = c.args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().map_err(err)?;
		if !o.status.success() {
			return Err(String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("PowerPoint 로 그림을 뽑지 못했다").to_string());
		}
		Ok(String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0))
	})
	.await
	.map_err(err)?
}
