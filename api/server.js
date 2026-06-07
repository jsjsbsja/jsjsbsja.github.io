const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://jsjsbsja-github-io.vercel.app';
const REDIRECT_URI = `${BASE_URL}/api/callback`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.NEXTAUTH_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Discord OAuth2 登入
app.get('/api/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Discord OAuth2 Callback
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();

    req.session.user = user;
    req.session.accessToken = tokenData.access_token;
    res.redirect('/dashboard.html');
  } catch (e) {
    res.redirect('/');
  }
});

// 登出
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// 取得目前用戶
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// 取得有管理權限的伺服器（Bot 也在其中）
app.get('/api/guilds', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not logged in' });

  try {
    // 取得用戶的伺服器
    const userGuildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });
    const userGuilds = await userGuildsRes.json();

    // 取得 Bot 的伺服器
    const botGuildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    const botGuilds = await botGuildsRes.json();
    const botGuildIds = new Set(botGuilds.map(g => g.id));

    // 篩選：用戶有管理權限 (0x8 = ADMINISTRATOR)
    const adminGuilds = userGuilds
      .filter(g => (parseInt(g.permissions) & 0x8) === 0x8)
      .map(g => ({ ...g, botIn: botGuildIds.has(g.id) }));

    res.json(adminGuilds);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

// 取得伺服器的 antiscam 設定
app.get('/api/guild/:guildId/config', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { guildId } = req.params;

  const { data, error } = await supabase
    .from('antiscam_config')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  if (error || !data) {
    // 回傳預設值
    return res.json({
      guild_id: guildId,
      enabled: true,
      bot_flood_enabled: true,
      bot_flood_seconds: 5,
      bot_flood_threshold: 10,
      spam_mute_enabled: true,
      spam_seconds: 5,
      spam_threshold: 6,
      mute_duration: 10,
      webhook_flood_enabled: true,
      webhook_flood_seconds: 1,
      webhook_flood_threshold: 5,
      webhook_mention_enabled: true,
      webhook_mention_seconds: 6,
      webhook_mention_threshold: 5,
      bot_mention_enabled: true,
      bot_mention_seconds: 5,
      bot_mention_threshold: 3,
      owner_notify_channel: null,
      alert_channel: null,
      alert_delete_after: 15
    });
  }

  res.json(data);
});

// 更新伺服器的 antiscam 設定
app.post('/api/guild/:guildId/config', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { guildId } = req.params;
  const config = req.body;
  config.guild_id = guildId;

  const { error } = await supabase
    .from('antiscam_config')
    .upsert(config, { onConflict: 'guild_id' });

  if (error) return res.status(500).json({ error: 'Failed to save config' });
  res.json({ success: true });
});

// 取得 Bot 邀請連結
app.get('/api/invite/:guildId', (req, res) => {
  const { guildId } = req.params;
  const url = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=8&scope=bot+applications.commands&guild_id=${guildId}`;
  res.json({ url });
});

// 取得伺服器頻道列表
app.get('/api/guild/:guildId/channels', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { guildId } = req.params;

  try {
    const r = await fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    const channels = await r.json();
    const textChannels = channels.filter(c => c.type === 0);
    res.json(textChannels);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

module.exports = app;

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
