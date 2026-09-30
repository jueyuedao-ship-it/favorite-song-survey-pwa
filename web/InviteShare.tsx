import { useEffect, useState } from "react";
import QRCode from "qrcode";

type Props = { link: string; title: string; onClose?: () => void };

export function InviteShare({ link, title, onClose }: Props) {
  const [qrData, setQrData] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 220, color: { dark: "#15325b", light: "#ffffff" } })
      .then((url) => { if (live) setQrData(url); })
      .catch(() => { if (live) setMessage("QRコードを作成できませんでした。リンクをコピーして共有してください。"); });
    return () => { live = false; };
  }, [link]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setMessage("招待リンクをコピーしました。");
    } catch {
      setMessage("下の招待リンクを選択してコピーしてください。");
    }
  }

  return <section className="invite-share" aria-label={title}>
    <div className="invite-share-heading"><div><h3>{title}</h3><p>このリンクは一度だけ使えます。信頼できる相手に共有してください。</p></div>
      {onClose && <button className="quiet-button" type="button" onClick={onClose}>閉じる</button>}</div>
    {qrData ? <img className="invite-qr" src={qrData} alt="招待リンクのQRコード" width="220" height="220" /> : <p role="status">QRコードを作成しています…</p>}
    <label className="invite-link-label">招待リンク
      <input aria-label="招待リンク" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
    </label>
    <div className="button-row"><button type="button" className="secondary-button" onClick={copyLink}>リンクをコピー</button></div>
    {message && <p role="status" className="inline-status">{message}</p>}
  </section>;
}
