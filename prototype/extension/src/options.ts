const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const manifest = chrome.runtime.getManifest();
$('build').textContent = `Build: ${manifest.version_name || manifest.version}`;
void chrome.storage.local
  .get<{ port?: number; token?: string; cleanupDays?: number }>(['port', 'token', 'cleanupDays'])
  .then(({ port, token, cleanupDays }) => {
    if (port) $('port').value = String(port);
    if (token) $('token').placeholder = '(saved)';
    if (cleanupDays != null) $('cleanupDays').value = String(cleanupDays);
  });
$('save').onclick = async () => {
  const token = $('token').value.trim();
  const port = +$('port').value || 9333;
  const cleanupDays = Math.max(0, +$('cleanupDays').value || 0);
  await chrome.storage.local.set<{ port: number; cleanupDays: number; token?: string; tokenSource?: string }>(
    token ? { token, tokenSource: 'manual', port, cleanupDays } : { port, cleanupDays },
  );
  $('msg').textContent = 'saved';
};
