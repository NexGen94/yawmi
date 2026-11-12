// The fallback route for a path the app does not know.
export function NotFound() {
  return (
    <>
      <h1>الصفحة غير موجودة</h1>
      <p class="not-found-text">
        <a class="not-found-link" href="/">
          العودة إلى الرئيسية
        </a>
      </p>
    </>
  );
}
