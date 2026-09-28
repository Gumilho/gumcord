<script lang="ts">
  import { store } from '$lib/store.svelte.ts';
</script>

<div class="login-wrap">
  <div class="login-box">
    <div class="login-logo">GC</div>
    <h1>Gumcord</h1>
    <p class="login-sub">Enter a name and the server password.</p>
    <form onsubmit={(e) => { e.preventDefault(); store.login(); }}>
      <input
        class="field"
        type="text"
        placeholder="Username"
        bind:value={store.loginInput}
        autocomplete="username"
        required
      />
      <input
        class="field"
        type="password"
        placeholder="Password"
        bind:value={store.passInput}
        autocomplete="current-password"
        required
      />
      {#if store.loginError}
        <p class="login-error">{store.loginError}</p>
      {/if}
      <button class="btn-primary" type="submit">Join</button>
    </form>
  </div>
</div>

<style>
  .login-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: #1a1b2e;
  }

  .login-box {
    width: 100%;
    max-width: 340px;
    background: #23253a;
    border: 1px solid #33365a;
    border-radius: 12px;
    padding: 36px 28px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .login-logo {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: #5b40c2;
    color: #fff;
    font-weight: 700;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    color: #e8eaf6;
  }

  .login-sub {
    margin: 0 0 24px;
    color: #6b7290;
    font-size: 13px;
    text-align: center;
  }

  form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field {
    width: 100%;
    padding: 9px 12px;
    border-radius: 7px;
    border: 1px solid #33365a;
    background: #1a1b2e;
    color: #d4d8f0;
    font-size: 14px;
    outline: none;
  }

  .field:focus { border-color: #7c5cbf; }

  .login-error {
    color: #e57373;
    font-size: 13px;
    margin: 0;
    text-align: center;
  }

  .btn-primary {
    padding: 9px 0;
    border-radius: 7px;
    border: none;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
  }

  .btn-primary:hover { background: #6d50d6; }
</style>
