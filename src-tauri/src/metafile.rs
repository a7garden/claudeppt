// EMF · WMF → PNG. 웹뷰는 Windows 그림 파일(EMF · WMF)을 그리지 못해, 가져온 PPTX 의 로고 · 도식이 빈 상자로 남았다 (2026.11.23).
// Windows 의 GDI+ 로 흰 바탕 · 검은 바탕에 한 번씩 그려 두 장의 차이로 투명도를 되살린다 —
// 옛 GDI 명령으로 된 EMF 는 투명 바탕에 바로 그리면 점의 투명도가 0 으로 남아 통째로 보이지 않는다.

use crate::{Res, err};
use std::path::PathBuf;

const CS: &str = r#"
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class Mf {
  static byte[] Draw(Metafile mf, int W, int H, Color bg) {
    using (var bm = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bm)) {
        g.Clear(bg); g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit; g.DrawImage(mf, new Rectangle(0, 0, W, H));
      }
      var d = bm.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var b = new byte[d.Stride * H]; Marshal.Copy(d.Scan0, b, 0, b.Length); bm.UnlockBits(d); return b;
    }
  }
  public static string Go(string src, string dst, int max) {
    string step = "open";
    try {
    // 경로 대신 스트림으로 연다 — GDI+ 는 한글 · 섞인 구분자(/ \) 경로에서 「일반 오류」를 낸다
    using (var ms = new System.IO.MemoryStream(System.IO.File.ReadAllBytes(System.IO.Path.GetFullPath(src))))
    using (var mf = new Metafile(ms)) {
      step = "draw";
      double w = mf.Width, h = mf.Height, s = max / Math.Max(w, h);
      int W = Math.Max(1, (int)Math.Round(w * s)), H = Math.Max(1, (int)Math.Round(h * s));
      byte[] a = Draw(mf, W, H, Color.White), k = Draw(mf, W, H, Color.Black), o = new byte[a.Length];
      for (int i = 0; i < a.Length; i += 4) {
        int al = 255 - Math.Max(a[i] - k[i], Math.Max(a[i + 1] - k[i + 1], a[i + 2] - k[i + 2]));
        if (al < 0) al = 0; if (al > 255) al = 255;
        o[i + 3] = (byte)al;
        if (al > 0) for (int c = 0; c < 3; c++) o[i + c] = (byte)Math.Min(255, k[i + c] * 255 / al);
      }
      step = "save " + W + "x" + H;
      using (var bm = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
        var d = bm.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(o, 0, d.Scan0, o.Length); bm.UnlockBits(d);
        // Bitmap.Save 는 경로에 따라 「일반 오류」를 낸다 — 스트림으로 쓴다
        using (var fs = System.IO.File.Create(System.IO.Path.GetFullPath(dst))) bm.Save(fs, ImageFormat.Png);
      }
      return W + "x" + H;
    }
    } catch (Exception e) { throw new Exception(step + ": " + e.Message); }
  }
}
"#;

/// dir 안 src(EMF · WMF)를 긴 변 max 픽셀 PNG 로 out 에 쓴다. 돌려주는 값은 "<너비>x<높이>"
#[tauri::command]
pub async fn metafile_png(dir: String, src: String, out: String, max: u32) -> Res<String> {
	tokio::task::spawn_blocking(move || {
		let d = PathBuf::from(&dir);
		let (s, o) = (d.join(&src), d.join(&out));
		if let Some(p) = o.parent() {
			std::fs::create_dir_all(p).map_err(err)?;
		}
		let q = |p: &PathBuf| p.to_string_lossy().replace('\'', "''");
		let script = format!(
			"$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'\n{CS}\n'@; [Mf]::Go('{}', '{}', {})",
			q(&s),
			q(&o),
			max.clamp(16, 4096)
		);
		let mut c = std::process::Command::new("powershell");
		crate::hidden(&mut c);
		let r = c.args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().map_err(err)?;
		if !r.status.success() {
			return Err(crate::fonts::decode(&r.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("EMF 를 그림으로 바꾸지 못했다").to_string());
		}
		Ok(String::from_utf8_lossy(&r.stdout).trim().to_string())
	})
	.await
	.map_err(err)?
}
