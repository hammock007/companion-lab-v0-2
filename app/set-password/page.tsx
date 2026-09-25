import { setPassword } from "./actions";

export default function SetPasswordPage() {
  return (
    <main
      style={{
        maxWidth: "420px",
        margin: "4rem auto",
        padding: "2rem",
        fontFamily: "sans-serif",
      }}
    >
      <h1>Set Companion Lab password</h1>
      <p>
        Use this once on the PC where you are already signed in.
      </p>

      <form>
        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="password"
            style={{ display: "block", marginBottom: "0.35rem" }}
          >
            New password
          </label>

          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "1rem",
            }}
          />
        </div>

        <div style={{ marginBottom: "1.25rem" }}>
          <label
            htmlFor="confirmPassword"
            style={{ display: "block", marginBottom: "0.35rem" }}
          >
            Confirm password
          </label>

          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "1rem",
            }}
          />
        </div>

        <button
          formAction={setPassword}
          style={{
            padding: "0.75rem 1.25rem",
            fontSize: "1rem",
            cursor: "pointer",
          }}
        >
          Set password
        </button>
      </form>
    </main>
  );
}