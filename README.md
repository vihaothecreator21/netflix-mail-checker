# Netflix Code Checker

Frontend: https://vihaothecreator21.github.io/netflix-mail-checker/

Người nhận mở link riêng, bấm **Lấy mã Netflix**. Chủ tài khoản dùng link thiết lập khác để **Kết nối Gmail** bằng OAuth. Quyền chỉ đọc; người nhận không đăng nhập Google. Chi phí mục tiêu 0đ/tháng trong hạn mức.

**Trạng thái:** frontend đã publish. Chưa cấu hình Google Cloud OAuth client, chưa deploy Apps Script, chưa kiểm chứng POST/redirect/CORS thật. Chưa thể lấy mã thật. Kiểm thử hiện dùng dữ liệu tổng hợp.

## Chạy local

Node ≥22.12:

```powershell
npm ci
npm test
Copy-Item .env.example .env.local
# Điền VITE_APPS_SCRIPT_URL sau khi deploy backend.
npm run dev
npm run build
```

Mở `http://127.0.0.1:5173/netflix-mail-checker/`. Không có endpoint thì nút lấy mã bị khóa. Trên máy hiện tại nếu npm wrapper hỏng, thay `npm` bằng `node D:\node_modules\npm\bin\npm-cli.js`.

## Chuẩn bị môi trường một lần — người triển khai

Phải hoàn tất các bước này trước khi bàn giao cho chủ Gmail chỉ đăng nhập/cấp quyền.

### 1. Apps Script

1. Tạo standalone project tại https://script.google.com/ bằng tài khoản vận hành backend. Tài khoản này không cần là Gmail đăng ký Netflix.
2. Thêm cả `apps-script/Code.gs` và `apps-script/OAuth.gs` vào project.
3. Project Settings → Show appsscript.json; thay bằng `apps-script/appsscript.json`.
4. Deploy → New deployment → Web app: Execute as **Me**, Who has access **Anyone**. Tài khoản vận hành tự cấp quyền gọi HTTPS bên ngoài; không cấp quyền Gmail ở bước này.
5. Lưu URL `/exec`, không dùng `/dev`.

### 2. Google Cloud OAuth

1. Tạo Google Cloud project, bật **Gmail API**.
2. Google Auth Platform: Branding, Audience External, Data Access gồm `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`.
3. Tạo **OAuth client → Web application**. Authorized redirect URI chính xác là URL `/exec` bên trên. Client secret không đưa vào frontend/GitHub.
4. Khi thử nghiệm, thêm đúng Gmail chủ Netflix vào Test users. Khi bàn giao lâu dài, xử lý chế độ Production và yêu cầu xác minh áp dụng cho project.

**Testing không phù hợp để kết nối lâu dài:** refresh token External Testing với Gmail scope thường hết hạn sau 7 ngày. Gmail readonly là restricted scope; Google có thể yêu cầu xác minh hoặc giới hạn người dùng. Không cam kết miễn xác minh. Xem [vòng đời OAuth token](https://developers.google.com/identity/protocols/oauth2#expiration), [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### 3. Script Properties và link riêng

Apps Script → Project Settings → Script Properties:

| Property | Giá trị |
| --- | --- |
| `BACKEND_URL` | URL `/exec` |
| `OAUTH_CLIENT_ID` | Client ID Google Cloud |
| `OAUTH_CLIENT_SECRET` | Client secret, chỉ ở backend |
| `OWNER_SETUP_HASH` | Hash tạo từ lệnh owner |
| `ACCESS_KEY_<tên>` | JSON hash từng người nhận |

```powershell
npm run create-link -- owner https://vihaothecreator21.github.io/netflix-mail-checker/
npm run create-link -- gia-dinh https://vihaothecreator21.github.io/netflix-mail-checker/
```

Lệnh chỉ in đường dẫn file `*.private.json` trong thư mục tạm hệ điều hành, ngoài repo. File chứa `privateLink`, `propertyName`, `propertyValue`. Thêm cặp property vào backend. Lưu link riêng vì hệ điều hành có thể dọn file tạm.

- `owner`: link `?setup=1#setup=<khóa>`, chỉ dành cho chủ Gmail; backend chỉ lưu SHA-256 ở `OWNER_SETUP_HASH`.
- Tên khác: link `#key=<khóa>`, tối đa 10 link. Property chứa JSON hash và enabled.
- Khóa dùng Node `crypto.randomBytes(32)`. Không đưa link vào issue, log, workflow hoặc repo.
- Thu hồi người nhận: xóa property hoặc đổi enabled thành false; không ảnh hưởng link khác.
- Thay link chủ: tạo lại owner, thay hash. Phiên OAuth cũ mất hiệu lực; Gmail đang kết nối được giữ lại.

### 4. GitHub Pages

Settings → Pages → Source: GitHub Actions. Settings → Secrets and variables → Actions → Variables: đặt `APPS_SCRIPT_URL` bằng URL `/exec`. Endpoint công khai, không chứa khóa/token.

Push main hoặc chạy workflow **Deploy GitHub Pages**. Workflow test/build/publish. Đổi tên repo thì tự đặt BASE_PATH; repo chính USERNAME.github.io cần `/`.

### 5. Kiểm chứng transport trước khi dùng mã thật

Chạy từ Console của chính trang GitHub Pages đã deploy. Probe xác thực và tính lượt, không đọc Gmail/OTP:

```js
(async () => {
  const endpoint = prompt('URL Apps Script /exec');
  const key = prompt('Khóa sau #key= trong link người nhận');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint || '') ||
      !/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Cấu hình không hợp lệ');
  const response = await fetch(endpoint, {
    method: 'POST', body: new URLSearchParams({ key, probe: '1' }),
    credentials: 'omit', redirect: 'follow', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  console.info(response.ok && data.status === 'not_found' ? 'POST/redirect/CORS: OK' : 'Probe chưa thành công');
})().catch(() => console.error('Kiểm tra deployment, quyền Anyone và CORS.'));
```

Phải thành công từ origin thật. Node/mock không chứng minh CORS. Nếu Google chặn redirect/CORS, chưa bàn giao; không dùng JSONP, no-cors, proxy công cộng để trả OTP.

## Bước cuối — chủ Gmail

1. Mở link thiết lập riêng, đợi kiểm tra cấu hình, bấm **Kết nối Gmail**.
2. Trong tab Google, chọn đúng Gmail đăng ký Netflix, cấp quyền chỉ đọc. Giữ trang thiết lập mở.
3. Quay lại, đợi **Đã kết nối Gmail**, kiểm tra địa chỉ hộp thư.
4. Mở link người nhận, bấm lấy mã sau khi có email Netflix thật mới gửi.

Khóa và phiên kết nối chỉ giữ trong bộ nhớ; fragment bị xóa. Reload cần mở lại link gốc. Không cần Gmail filter: backend tự tìm From thuộc netflix.com/subdomain thật và tiêu đề mã đăng nhập/xác minh tiếng Việt hoặc Anh. Bố cục/tiêu đề khác có thể cần chỉnh bằng mẫu đã xóa dữ liệu cá nhân. Email chỉ có nút Get Code không hỗ trợ.

Tùy chọn: `NETFLIX_SENDERS` là JSON địa chỉ From chính xác, tối đa 10. `NETFLIX_LABEL_ID` là ID nhãn chủ Gmail đã tạo/gắn đúng thư mã; có label thì dùng label thay lọc tiêu đề. Readonly không tự tạo nhãn/filter.

## Vận hành và dữ liệu

- Viewer chỉ POST; xác thực trước Gmail. Một lần/30 giây/link, 1.000 lượt/ngày toàn hệ thống, reset 00:00 UTC. Properties + LockService chống tranh chấp.
- Chọn email mới nhất theo internalDate trong 15 phút. Email mới nhất thiếu mã, nhiều mã khác nhau hoặc timestamp trùng: unreadable; không dùng mã cũ.
- Parse MIME/plain/HTML, bỏ attachments/script/style. Không mở URL, tải ảnh, render HTML hoặc sửa email/trạng thái đã đọc. Tối đa 50 email ứng viên; còn trang tiếp theo thì báo lỗi.
- OAuth dùng state, nonce, PKCE S256, verifier trong bộ nhớ. Một phiên tạm tối đa 10 phút, redeem một lần; bắt đầu mới thay phiên cũ sau thời gian chờ 30 giây. Polling chỉ trong luồng cấp quyền, không polling Gmail.
- Backend đổi code trực tiếp qua HTTPS Google, kiểm tra issuer/audience/expiry/nonce/email verified/scope. Client secret, refresh token, Gmail email/sub chỉ ở Script Properties. Không log exception, OTP, khóa hoặc nội dung thư. Không CacheService.
- Người có quyền sửa Apps Script có thể đọc Properties; chỉ cấp quyền project cho người tin cậy.
- Không âm thầm đổi Gmail đã kết nối. Muốn đổi: thu hồi quyền ở Google cũ; quản trị viên xóa MAILBOX_REFRESH_TOKEN, MAILBOX_EMAIL, MAILBOX_SUB, MAILBOX_CONNECTED, OAUTH_PENDING rồi kết nối lại. Quyền hết hạn/thu hồi: dùng link chủ để cấp lại.
- Xóa OTP khi kiểm tra lại, lỗi hoặc đạt 15 phút. Không lưu localStorage/sessionStorage/cookie, không analytics hay script bên thứ ba. Mốc 15 phút không bảo đảm mã Netflix còn hiệu lực/chưa dùng.
- GET không trả OTP. Callback chỉ ghi code tạm và thông báo quay lại trang thiết lập. Google quản lý HTTP headers của ContentService.
- Endpoint công khai vẫn chịu quota Apps Script; rate limit không bảo đảm chống cạn quota. Chi phí 0đ trong hạn mức, không SLA.

## API và kiểm thử

POST /exec, application/x-www-form-urlencoded, key=64 hex; tùy chọn probe=1.

```ts
type CheckResponse = {
  status: 'found' | 'not_found' | 'unreadable' | 'unauthorized'
    | 'rate_limited' | 'not_connected' | 'error';
  otp: string | null;
  receivedAt: string | null;
  checkedAt: string;
  hideAt: string | null;
  retryAfterSeconds?: number;
};
```

Chỉ found trả OTP. Owner POST dùng khóa chủ, action owner_status/owner_start/owner_finish; không trả token. ContentService không đặt HTTP status tùy ý, frontend kiểm tra JSON status/schema.

npm test chạy Node assert trên mã Apps Script thực với Google/Properties/Lock giả lập: parser, số 0 đầu, MIME/HTML, email cũ/mới nhất lỗi, khóa sai/thu hồi, quota/concurrency; OAuth state/PKCE/nonce, replay, denial, hết phiên, thu hồi quyền, chặn đổi hộp thư.

Các test không thay Google consent, Gmail thật, CORS hoặc thiết bị thật. Sửa script xong: Deploy → Manage deployments → Edit → New version để giữ URL. Sửa Properties không cần deploy lại.
