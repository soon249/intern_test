'use strict';

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  btn.disabled = true; err.style.display = 'none';
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { username: document.getElementById('username').value.trim(), password: document.getElementById('password').value }
    });
    location.href = r.role === 'admin' ? '/admin' : '/candidate';
  } catch (ex) {
    err.textContent = ex.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Invalid username or password.';
    err.style.display = 'block';
    btn.disabled = false;
  }
});
