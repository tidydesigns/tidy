import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
const { LoginForm } = await import("@/app/login/login-form");
const { SignUpForm } = await import("@/app/sign-up/sign-up-form");
const { ResetPasswordForm } = await import("@/app/reset-password/reset-form");
const { ForgotPasswordForm } = await import("@/app/forgot-password/reset-form");
const { VerificationForm } = await import("./verification-form");

// This is the HTML a browser can submit before hydration or if JavaScript fails.
// GET's native fallback would put account details and passwords in URL history.
test("account forms submit private fields in the request body before hydration", () => {
  for (const form of [
    <LoginForm key="login" />,
    <SignUpForm key="signup" emailConfigured />,
    <ResetPasswordForm key="reset" token="disposable-reset-token" />,
    <ForgotPasswordForm key="forgot" emailConfigured />,
    <VerificationForm key="verify" next="/" emailConfigured />,
  ]) {
    const html = renderToStaticMarkup(form);
    expect(html).toMatch(/<form\b[^>]*method="post"/);
    expect(html).not.toContain('method="get"');
  }
});
