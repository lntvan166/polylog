/**
 * A commit's web page from a remote URL, for "Open on Remote". Pure: no vscode import.
 * Credentials in the URL are dropped, never opened.
 */

const SHA = /^[0-9a-f]{40}$/;

interface Remote { scheme: "https" | "http"; host: string; port?: string; path: string }

function parseRemote(url: string): Remote | undefined {
  const u = url.trim();
  if (/^[a-z]:[\\/]/i.test(u)) return undefined; // a Windows path (C:\repos\x.git), not host:path
  // scp-like ssh: git@host:owner/repo.git
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (scp && !/^[a-z]+:\/\//i.test(u)) return { scheme: "https", host: scp[1], path: scp[2] };
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme === "ssh" || scheme === "git" || scheme === "git+ssh") return { scheme: "https", host: parsed.hostname, path: parsed.pathname };
  // An http(s) port is the web server's; an ssh port is not.
  if (scheme === "https" || scheme === "http") return { scheme, host: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname };
  return undefined; // file://, a local path
}

export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  if (!SHA.test(sha)) return null;
  const r = parseRemote(remoteUrl);
  if (!r || !r.host) return null;
  const path = r.path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path) return null;
  const base = `${r.scheme}://${r.host}${r.port ? `:${r.port}` : ""}`;
  // Azure DevOps over ssh: ssh.dev.azure.com:v3/org/project/repo.
  const azureSsh = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (r.host === "ssh.dev.azure.com" && azureSsh) return `https://dev.azure.com/${azureSsh[1]}/${azureSsh[2]}/_git/${azureSsh[3]}/commit/${sha}`;
  if (r.host === "dev.azure.com" || r.host.endsWith(".visualstudio.com")) return `${base}/${path}/commit/${sha}`;
  if (r.host === "bitbucket.org") return `${base}/${path}/commits/${sha}`;
  if (r.host === "gitlab.com" || r.host.startsWith("gitlab.")) return `${base}/${path}/-/commit/${sha}`;
  // GitHub, Gitea, Forgejo and most others.
  return `${base}/${path}/commit/${sha}`;
}
