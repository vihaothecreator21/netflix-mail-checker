import { useEffect, useRef, useState } from 'react';
import { consumeKey, post, validEndpoint } from './api.js';

const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('');
const messages = {
  idle: 'Kiểm tra cấu hình trước khi kết nối Gmail nhận email Netflix.',
  loading: 'Đang kiểm tra cấu hình…',
  ready: 'Sẵn sàng. Chọn đúng Gmail đăng ký Netflix rồi cấp quyền chỉ đọc.',
  pending: 'Hoàn tất đăng nhập và cấp quyền trong tab Google. Giữ trang này mở.',
  connected: 'Đã kết nối Gmail. Người có link riêng có thể lấy mã.',
  unauthorized: 'Link thiết lập không hợp lệ hoặc đã bị thay thế. Mở lại link riêng của chủ tài khoản.',
  error: 'Không thể kết nối. Kiểm tra cấu hình OAuth và thử lại.',
  unconfigured: 'Backend chưa được cấu hình OAuth. Cần hoàn tất môi trường triển khai trước.',
  denied: 'Chưa được cấp quyền Gmail. Có thể thử kết nối lại.',
  expired: 'Phiên kết nối đã hết hạn. Bấm kết nối để thử lại.',
  different_mailbox: 'Đã có Gmail khác được kết nối. Cần quản trị viên đặt lại backend để đổi hộp thư.',
  busy: 'Đang có yêu cầu khác. Đợi 30 giây rồi thử lại.',
};

export function OwnerSetup({ endpoint }) {
  const [key] = useState(() => consumeKey(location, history, 'setup'));
  const [status, setStatus] = useState('idle');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const popup = useRef(null);
  useEffect(() => {
    if (key && validEndpoint(endpoint)) inspect();
    return () => { active.current = false; popup.current?.close(); };
  }, []);
  const effective = !key ? 'unauthorized' : !validEndpoint(endpoint) ? 'unconfigured' : status;

  async function inspect() {
    setBusy(true);
    setStatus('loading');
    try {
      const data = await post(endpoint, { key, action: 'owner_status' });
      if (data.status !== 'owner_status') setStatus(data.status === 'unauthorized' ? 'unauthorized' : 'error');
      else {
        setEmail(typeof data.email === 'string' ? data.email : '');
        setStatus(data.connected ? 'connected' : data.configured ? 'ready' : 'unconfigured');
      }
    } catch { setStatus('error'); }
    finally { setBusy(false); }
  }

  async function connect() {
    // Open synchronously on the user gesture; OAuth carries no setup secret.
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setStatus('error'); return; }
    tab.opener = null;
    popup.current = tab;
    setBusy(true);
    try {
      const state = random();
      const verifier = random();
      const nonce = random();
      const start = await post(endpoint, { key, action: 'owner_start', state, nonce, challenge: await digest(verifier) });
      if (start.status !== 'authorize') { setStatus(messages[start.status] ? start.status : 'error'); return; }
      const url = new URL(start.url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.searchParams.get('state') !== state) throw new Error('INVALID_AUTH_URL');
      tab.location.replace(url.href);
      setStatus('pending');
      const deadline = performance.now() + 10 * 60 * 1000;
      while (active.current && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!active.current) return;
        const data = await post(endpoint, { key, action: 'owner_finish', state, verifier });
        if (data.status === 'pending' || data.status === 'busy') continue;
        if (data.status === 'connected' && typeof data.email === 'string') setEmail(data.email);
        setStatus(messages[data.status] ? data.status : 'error');
        return;
      }
      if (active.current) setStatus('expired');
    } catch { if (active.current) setStatus('error'); }
    finally { tab.close(); popup.current = null; if (active.current) setBusy(false); }
  }

  return <div className="shell"><header><span className="brand">NETFLIX CODE CHECKER</span></header>
    <main><div className="eyebrow">CHỈ DÀNH CHO CHỦ TÀI KHOẢN</div><h1>Kết nối Gmail.</h1>
      <p className="intro">Đăng nhập Gmail nhận email Netflix. Quyền chỉ đọc; token được giữ ở backend.</p>
      <section className="checker" aria-label="Thiết lập Gmail">
        <h2>Gmail của chủ Netflix</h2>
        {email && <p>{email}</p>}
        <p role="status" className="intro">{messages[effective]}</p>
        <button disabled={busy || !key || !validEndpoint(endpoint)} onClick={['idle', 'unconfigured'].includes(status) ? inspect : connect}>
          {busy ? 'Đang xử lý…' : ['idle', 'unconfigured'].includes(status) ? 'Kiểm tra kết nối' : status === 'connected' ? 'Cấp quyền lại Gmail' : 'Kết nối Gmail'}
        </button>
      </section>
      <p className="disclaimer">Giữ kín link thiết lập. Ai có link này có thể cấp quyền kết nối hộp thư. Tải lại trang cần mở lại link gốc.</p>
    </main></div>;
}
