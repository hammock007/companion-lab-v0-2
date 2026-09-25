import { login } from "./actions";

export default function LoginPage() {
  return (
    <main
      style={{
        maxWidth: "420px",
        margin: "4rem auto",
        padding: "2rem",
        fontFamily: "sans-serif",
      }}
    >
      <h1>Companion Lab</h1>
      <p>Sign in to continue.</p>

      <form>
        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="email"
            style={{ display: "block", marginBottom: "0.35rem" }}
          >
            Email
          </label>

          <input
            id="email"
            name="email"
            type="email"
            required
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "1rem",
            }}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="password"
            style={{ display: "block", marginBottom: "0.35rem" }}
          >
            Password
          </label>

          <input
            id="password"
            name="password"
            type="password"
            required
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "1rem",
            }}
          />
        </div>

        <button
          formAction={login}
          style={{
            padding: "0.75rem 1.25rem",
            fontSize: "1rem",
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
      </form>
    </main>
  );
}