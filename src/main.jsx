import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { checkCode, consumeKey, validEndpoint } from './api.js';
import './style.css';

const endpoint = (import.meta.env.VITE_APPS_SCRIPT_URL || '').trim();
const messages = {
  idle: 'Bấm nút để kiểm tra email Netflix mới nhất.',
  loading: 'Đang kiểm tra email…',
  found: 'Đã tìm thấy mã trong email mới nhất.',
  not_found: 'Chưa có email Netflix phù hợp trong 15 phút gần đây.',
  unreadable: 'Đã nhận email, nhưng không tìm thấy một mã 4 số rõ ràng.',
  unauthorized: 'Link không hợp lệ hoặc đã được thu hồi. Liên hệ chủ tài khoản để nhận link mới.',
  missing_key: 'Mở link riêng do chủ tài khoản cung cấp để lấy mã.',
  setup: 'Website chưa được cấu hình kết nối Gmail.',
  rate_limited: 'Đã đạt giới hạn kiểm tra. Vui lòng đợi trước khi thử lại.',
  error: 'Không thể kiểm tra lúc này. Kết nối Gmail hoặc hạn mức có thể đang gặp lỗi.',
  expired: 'Mã đã được ẩn sau 15 phút. Bấm nút để kiểm tra email mới.',
};
const time = (value) => new Date(value).toLocaleTimeString('vi-VN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const remaining = (deadline) => deadline
  ? Math.max(0, Math.min(deadline.wall - Date.now(), deadline.mono - performance.now())) : 0;
const deadlineAfter = (ms) => ({ wall: Date.now() + ms, mono: performance.now() + ms });

function App() {
  const [key, setKey] = useState(() => consumeKey(window.location, window.history));
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(null);
  const [hideDeadline, setHideDeadline] = useState(null);
  const [, refresh] = useState(0);
  const effectiveStatus = !validEndpoint(endpoint) ? 'setup'
    : !key ? (status === 'unauthorized' ? status : 'missing_key') : status;
  const wait = Math.ceil(remaining(cooldown) / 1000);
  const hasCode = effectiveStatus === 'found' && result?.otp && remaining(hideDeadline) > 0;

  useEffect(() => {
    const reopen = () => { if (window.location.hash) window.location.reload(); };
    window.addEventListener('hashchange', reopen);
    return () => window.removeEventListener('hashchange', reopen);
  }, []);

  useEffect(() => {
    function tick() {
      if (hideDeadline && remaining(hideDeadline) <= 0) {
        setResult(null);
        setHideDeadline(null);
        setStatus('expired');
      }
      if (cooldown && remaining(cooldown) <= 0) setCooldown(null);
      refresh((n) => n + 1);
    }
    if (!hideDeadline && !cooldown) return;
    const timer = setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [hideDeadline, cooldown]);

  async function handleCheck() {
    if (busy || wait || !key || !validEndpoint(endpoint)) return;
    setResult(null);
    setHideDeadline(null);
    setBusy(true);
    setStatus('loading');
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const data = await checkCode(endpoint, key, controller.signal);
      setStatus(data.status);
      setCooldown(deadlineAfter(data.status === 'rate_limited' ? data.retryAfterSeconds * 1000 : 30000));
      if (data.status === 'unauthorized') {
        setKey('');
        setCooldown(null);
      } else if (data.status === 'found') {
        const lifetime = Date.parse(data.hideAt) - Date.parse(data.checkedAt) - (performance.now() - started);
        if (lifetime > 0) {
          setResult(data);
          setHideDeadline(deadlineAfter(lifetime));
        } else setStatus('expired');
      } else setResult(data);
    } catch {
      setStatus('error');
      setCooldown(deadlineAfter(30000));
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header>
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="Netflix Code Checker, trang chủ">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>NETFLIX <span className="brand-light">CODE CHECKER</span></span>
        </a>
        <span className={`connection ${hasCode ? 'connected' : ''}`}>
          <span aria-hidden="true" />{hasCode ? 'Đã kết nối' : 'Truy cập bằng link riêng'}
        </span>
      </header>

      <main>
        <div className="eyebrow">MÃ ĐĂNG NHẬP TỪ EMAIL</div>
        <h1>Mã Netflix.<br /><span>Ngay khi bạn cần.</span></h1>
        <p className="intro">Kiểm tra email của chủ tài khoản và lấy mã 4 số mới nhất chỉ với một lần bấm.</p>

        <section className="checker" aria-labelledby="checker-title">
          <div className="card-heading">
            <div><p className="overline">HỘP THƯ ĐƯỢC CẤP QUYỀN</p><h2 id="checker-title">Lấy mã Netflix</h2></div>
            <svg className="mail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>
          </div>

          <div className="code-area" aria-live="polite" aria-atomic="true">
            {hasCode ? <>
              <p className="code-caption">Mã từ email mới nhất</p>
              <div className="digits" aria-label={`Mã Netflix: ${result.otp.split('').join(' ')}`}>
                {result.otp.split('').map((digit, i) => <span key={i} aria-hidden="true">{digit}</span>)}
              </div>
              <p className="received">Nhận lúc {time(result.receivedAt)}</p>
            </> : <>
              <div className="digits placeholder" aria-hidden="true"><span>–</span><span>–</span><span>–</span><span>–</span></div>
              <p className="code-caption">{busy ? 'Đang tìm mã mới nhất' : 'Mã sẽ hiển thị tại đây'}</p>
            </>}
          </div>

          <button onClick={handleCheck} disabled={busy || wait > 0 || !key || !validEndpoint(endpoint)}>
            {busy ? 'Đang kiểm tra…' : wait > 0 ? `Thử lại sau ${wait}s` : 'Lấy mã Netflix'}
            {!busy && !wait && <span aria-hidden="true">↗</span>}
          </button>
          <div className={`status status-${effectiveStatus}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            <p>{messages[effectiveStatus]}</p>
          </div>
          {result?.checkedAt && <p className="checked">Kiểm tra lúc {time(result.checkedAt)}</p>}
        </section>

        <div className="notes">
          <div><span className="note-number">01</span><p><strong>Chỉ email mới</strong><br />Trong vòng 15 phút gần đây.</p></div>
          <div><span className="note-number">02</span><p><strong>Giữ kín link riêng</strong><br />Ai có link đều có thể lấy mã.</p></div>
        </div>
        <p className="disclaimer">Mã có thể đã được sử dụng hoặc hết hiệu lực trên Netflix. Website không xác nhận hiệu lực mã.</p>
      </main>
      <footer><span>Netflix Code Checker</span><span>Công cụ độc lập, không liên kết với Netflix.</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
