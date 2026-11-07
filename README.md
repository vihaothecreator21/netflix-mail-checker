# Netflix Code Checker

Mở link riêng, bấm **Lấy mã Netflix**, xem mã 4 số từ email mới nhất của chủ tài khoản. React + Vite trên GitHub Pages; Google Apps Script đọc Gmail bằng quyền của chủ hộp thư. Không cần Google Sign-In cho người nhận link.

## Chạy local

Yêu cầu Node.js ≥22.12 và npm.

```powershell
npm install
Copy-Item .env.example .env.local
# Điền VITE_APPS_SCRIPT_URL trong .env.local sau khi deploy Apps Script.
npm test
npm run dev
```

Mở `http://127.0.0.1:5173/netflix-mail-checker/`. Chưa có endpoint hoặc link riêng, trang hiển thị hướng dẫn tương ứng; không giả lập email thành công.

```powershell
npm run build
npm run preview
```

Mặc định build dùng `/netflix-mail-checker/`. Với tên repository khác, đặt biến môi trường `BASE_PATH`, gồm dấu `/` ở hai đầu. Workflow GitHub tự lấy tên repository.

## 1. Chuẩn bị Gmail

1. Dùng Gmail của chủ tài khoản Netflix. Tạo nhãn **NetflixVerification**.
2. Mở email Netflix thực tế chứa mã bốn số. Xem địa chỉ **From** đầy đủ và tiêu đề; không chỉ dựa vào tên hiển thị “Netflix”.
3. Tạo Gmail filter theo đúng địa chỉ gửi và tiêu đề của email chứa mã. Chọn **Apply the label → NetflixVerification**. Không gắn nhãn này cho email thanh toán, quảng cáo, đổi mật khẩu hoặc email chỉ có nút “Get Code”.
4. Có thể áp dụng filter cho email cũ; backend vẫn chỉ xét 15 phút gần nhất. Không chọn xóa hoặc chuyển tiếp email.

Ghi lại địa chỉ gửi đã xác nhận để cấu hình `NETFLIX_SENDERS`. Địa chỉ phải thuộc `netflix.com` hoặc subdomain thật của Netflix. Không dùng địa chỉ ví dụ nếu khác email thực tế.

## 2. Tạo Apps Script

1. Đăng nhập tài khoản chủ Gmail, tạo standalone project tại [Google Apps Script](https://script.google.com/).
2. Chép `apps-script/Code.gs` vào file `Code.gs`.
3. Vào **Project Settings → Show appsscript.json manifest file**; thay manifest bằng `apps-script/appsscript.json`. Manifest bật Gmail API v1 và chỉ xin scope `gmail.readonly`.
4. Nếu dùng Google Cloud project riêng, bật **Gmail API** trong project đó. Project mặc định của Apps Script thường tự bật khi thêm advanced service.
5. Chạy `authorizeOwner`, chấp thuận quyền bằng tài khoản chủ Gmail. Chỉ chủ hộp thư thực hiện bước này.
6. Chạy `configureNetflixLabel`. Hàm tìm nhãn đã tạo, tự lưu `NETFLIX_LABEL_ID` vào Script Properties.
7. Vào **Project Settings → Script Properties**, thêm `NETFLIX_SENDERS` với giá trị JSON, ví dụ `["info@account.netflix.com"]` **chỉ khi đúng với email thực tế**.
8. **Deploy → New deployment → Web app**: **Execute as: Me**, **Who has access: Anyone**. Không chọn chế độ chỉ dành cho người đã đăng nhập Google. Sao chép URL kết thúc bằng `/exec`, không dùng `/dev`.

Endpoint nhận request công khai; việc đọc Gmail được bảo vệ bằng khóa riêng phía server. Không dùng `Session.getActiveUser()` để xác thực người nhận link.

Google có thể hiện cảnh báo ứng dụng chưa xác minh cho chủ Gmail khi cấp quyền. Với ứng dụng cá nhân, chỉ tiếp tục khi đã kiểm tra đúng project/mã nguồn của mình. Quyền có thể phải cấp lại khi bị thu hồi hoặc thay đổi cấu hình OAuth; ứng dụng OAuth ở chế độ Testing có thể có giới hạn thời hạn cấp quyền.

## 3. Tạo link riêng

```powershell
npm run create-link -- gia-dinh https://USERNAME.github.io/netflix-mail-checker/
```

Lệnh dùng `crypto.randomBytes(32)`, tạo file `*.private.json` trong thư mục tạm của hệ điều hành, **ngoài repository**. Terminal chỉ in đường dẫn file, không in khóa. File chứa:

- `privateLink`: gửi riêng cho người nhận; không đưa vào issue, screenshot, CI, README hoặc repository.
- `propertyName`: ví dụ `ACCESS_KEY_gia-dinh`.
- `propertyValue`: JSON chỉ chứa hash SHA-256 và `enabled`, không chứa khóa thô.

Thêm cặp `propertyName`/`propertyValue` vào Script Properties. Mỗi người dùng một tên khác nhau, tối đa 10 property có prefix `ACCESS_KEY_` (tính cả property đã tắt). Lưu link trong nơi riêng do chủ tài khoản quản lý; file tạm có thể bị hệ điều hành dọn.

**Thu hồi:** đổi `enabled` thành `false` hoặc xóa property tương ứng. **Cấp lại:** tạo link mới rồi thay property; khóa cũ mất hiệu lực. Chỉ có hash thì không khôi phục được link cũ.

Khóa nằm trong URL fragment `#key=...`, không được gửi khi tải trang GitHub Pages. Trang đọc rồi xóa fragment, giữ khóa trong bộ nhớ. **Reload cần mở lại link gốc.** Ai có link còn hiệu lực đều có thể lấy mã.

## 4. Deploy GitHub Pages

1. Tạo repository GitHub, đưa mã nguồn lên branch `main`. Không commit `.env.local`, file private, token hoặc nội dung Gmail.
2. **Settings → Pages → Source: GitHub Actions**.
3. Có thể deploy frontend trước khi cấu hình Gmail; trang sẽ hiện trạng thái chưa kết nối và khóa nút lấy mã. Khi backend sẵn sàng, vào **Settings → Secrets and variables → Actions → Variables**, tạo repository variable `APPS_SCRIPT_URL` chứa URL `/exec`, rồi chạy lại workflow. Endpoint là cấu hình công khai; không đưa access key vào bất kỳ biến `VITE_*` nào.
4. Push `main` hoặc chạy workflow **Deploy GitHub Pages**. Workflow chạy `npm ci`, `npm test`, build rồi deploy.
5. URL thông thường: `https://USERNAME.github.io/TEN-REPOSITORY/`. Tạo link riêng bằng đúng URL này.

Nếu repository chính tên `USERNAME.github.io`, chỉnh `BASE_PATH` của workflow thành `/`.

## 5. Kiểm chứng redirect và CORS trước khi dùng OTP

Chưa thể kiểm chứng kết nối thực tế chỉ bằng mã nguồn: cần deployment `/exec`, quyền chủ Gmail và origin GitHub Pages thật. Không coi unit test hoặc request từ Node là bằng chứng CORS hoạt động.

Mở trang GitHub Pages đã publish, mở DevTools Console, chạy đoạn dưới. Nhập endpoint và khóa lấy từ link riêng khi được hỏi. Chỉ dùng Console của **trang mình vừa deploy**. Đoạn kiểm tra chỉ in trạng thái kết nối; `probe=1` xác thực khóa và giới hạn tần suất nhưng **không đọc Gmail, không trả OTP**.

```js
(async () => {
  const endpoint = prompt('URL Apps Script /exec');
  const key = prompt('Khóa sau #key= trong link riêng');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint || '') ||
      !/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Cấu hình không hợp lệ');
  const response = await fetch(endpoint, {
    method: 'POST',
    body: new URLSearchParams({ key, probe: '1' }),
    credentials: 'omit', redirect: 'follow', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('HTTP không thành công');
  const data = await response.json();
  console.info(data.status === 'not_found' ? 'POST/redirect/CORS: OK, chưa đọc Gmail' : `Probe: ${data.status}`);
})().catch(() => console.error('Probe thất bại; kiểm tra deployment, quyền Anyone và CORS.'));
```

Chỉ chấp nhận probe thành công từ origin thật, sau đó đợi 30 giây trước khi bấm lấy mã. Nếu trình duyệt chặn CORS/redirect, **chưa đưa vào sử dụng**. Kiểm tra URL `/exec`, phiên bản deployment và quyền Anyone. Không dùng JSONP, proxy công cộng hoặc `mode: 'no-cors'`; không thêm `Authorization` hay header tùy chỉnh gây preflight. Nếu vẫn bị chặn, kiến trúc kết nối cần được điều chỉnh trước khi phát hành.

Sau probe, kiểm tra bằng email Netflix thật mới nhận trên desktop Chrome, Android Chrome và iPhone Safari. Không lưu hoặc commit OTP thật làm fixture. Backend đã có parser tiếng Việt/Anh; mẫu ngôn ngữ hoặc bố cục khác có thể cần bổ sung bằng fixture đã thay mã và xóa thông tin cá nhân.

## Hành vi và giới hạn

- Chỉ POST nhận khóa trong body. GET không trả mã. Link sai hoặc bị thu hồi không đọc Gmail.
- Tìm theo label và địa chỉ From đã cấu hình, loại spam/trash, kiểm tra tuổi email bằng `internalDate` của Google. Không dùng ngày trong nội dung email.
- Chọn email mới nhất trước khi trích mã. Email mới nhất không đọc được, có nhiều mã khác nhau hoặc nhiều email trùng timestamp: `unreadable`, không trả mã cũ.
- Parse MIME, ưu tiên plain text, fallback HTML; bỏ attachment, script, style và thuộc tính HTML. Không thực thi HTML, tải ảnh, mở URL hoặc thay đổi trạng thái Gmail.
- Mỗi lần đọc tối đa 50 email ứng viên. Nếu còn trang tiếp theo hoặc MIME vượt giới hạn, trả `error`; không chọn kết quả từ tập chưa đầy đủ.
- Một lần/30 giây/link; tối đa 1.000 lần/ngày toàn hệ thống, reset **00:00 UTC (07:00 Việt Nam)**. Lỗi sau khi xác thực cũng tiêu thụ lượt. Probe cũng tiêu thụ lượt. LockService bảo vệ bộ đếm đồng thời; yêu cầu không lấy được lock trả `rate_limited`.
- Script Properties chỉ chứa cấu hình, hash khóa và bộ đếm; CacheService không được dùng. Không ghi exception/raw request vào log.
- Khóa/mã không lưu localStorage, sessionStorage, cookie, analytics hoặc service worker. Phản hồi dùng `cache: 'no-store'` ở client; ContentService do Google quản lý HTTP headers nên không tự đặt được response `Cache-Control`.
- Mã bị xóa trước mỗi lần kiểm tra, khi lỗi hoặc khi đạt 15 phút. Timer và visibility check chỉ cập nhật UI, không polling Gmail. Mốc 15 phút không xác nhận mã còn được Netflix chấp nhận.
- Chi phí mục tiêu 0đ trong hạn mức. Rate limit giảm lượt Gmail hợp lệ; endpoint công khai vẫn chịu quota thực thi Apps Script. Không có SLA hoặc cam kết chống cạn quota.

## API

`POST /exec`, body `key=<64 ký tự hex>`; tùy chọn `probe=1` để kiểm tra transport mà không đọc Gmail.

```ts
type CheckResponse = {
  status: 'found' | 'not_found' | 'unreadable' | 'unauthorized'
    | 'rate_limited' | 'error';
  otp: string | null;
  receivedAt: string | null;
  checkedAt: string; // ISO 8601 UTC
  hideAt: string | null;
  retryAfterSeconds?: number;
};
```

Chỉ `found` có `otp` và `hideAt`. Các lỗi nghiệp vụ nằm trong JSON vì Apps Script ContentService không cung cấp API đặt HTTP status tùy ý. Frontend kiểm tra cả HTTP, JSON và schema; không coi HTTP 200 là đã nhận mã.

## Kiểm thử

`npm test` dùng Node `assert` và sandbox `vm` để chạy trực tiếp mã Apps Script với Gmail/Properties/Lock giả lập. Bao phủ số 0 đầu, MIME/HTML, mã mơ hồ, email hết hạn, chọn email mới nhất, khóa bị thu hồi/đổi, rate limit, cạnh tranh lock, cấu hình lỗi, link generator và định dạng request frontend.

Các test này không thay thế kiểm thử Google consent, Gmail thật, CORS và thiết bị thật. Sau mỗi lần sửa Apps Script: **Deploy → Manage deployments → Edit → New version** để giữ nguyên URL `/exec`; thay Script Properties không cần deploy lại.
