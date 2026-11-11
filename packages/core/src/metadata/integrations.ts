// Integrations: where an org connects out and what comes in. Named and external credentials,
// remote site settings, connected apps, external services, outbound messages and platform
// event channels. Only hosts are kept of URLs (a path or query can carry a token or a
// client's name), in descriptions too, and never a secret, a consumer key, a certificate, a
// username, an email or an IP address. A host can still name a client (acme.example.com): it
// is what an architect needs to see where the org connects.

import type { ParsedComponent, Ref } from "./model.js";
import { bool, list, obj, str } from "./xml.js";

const NAME = /^[A-Za-z]\w*$/;
/** Shown in place of a host that is an IP address, which the masking rules treat as personal. */
export const IP_HOST = "(an IP address)";

/**
 * The host of a URL ("api.example.com"), or undefined when it is not one; merge fields
 * ({!$Credential...}) are not hosts, and an IP address is shown as IP_HOST.
 */
export function hostOf(url: string | undefined): string | undefined {
  if (!url || url.includes("{!")) return undefined;
  try {
    const u = new URL(url.trim());
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return undefined;
    const host = u.hostname.toLowerCase();
    return host.startsWith("[") || /^[\d.]+$/.test(host) ? IP_HOST : host;
  } catch {
    return undefined;
  }
}

/** People's text with every URL cut to its host: a path or query can carry a token. */
export function hostsOnly(text: string): string {
  return text.replace(/\b[a-z][\w+.-]*:\/\/[^\s<>"')\]]+/gi, (url) => hostOf(url) ?? "(a link)");
}

const joinText = (...parts: (string | undefined)[]) => hostsOnly(parts.filter((p): p is string => !!p && p.trim() !== "").join("\n"));

const withAttrs = (attrs: Record<string, unknown>) => Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));

/**
 * A named credential: the host it calls, and the external credential it authenticates with
 * (`references`). Both the legacy form (<endpoint>) and the current one (parameters) are read.
 */
export function readNamedCredential(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  let url = str(root.endpoint);
  // A legacy named credential names its OAuth provider itself.
  const provider = str(root.authProvider);
  if (provider && NAME.test(provider)) refs.push({ kind: "references", type: "AuthProvider", name: provider, known: true });
  for (const p of list(root.namedCredentialParameters).map(obj)) {
    const type = str(p.parameterType);
    if (type === "Url") url ??= str(p.parameterValue);
    const external = str(p.externalCredential);
    if (type === "Authentication" && external && NAME.test(external)) refs.push({ kind: "references", type: "ExternalCredential", name: external });
  }
  const attrs = withAttrs({
    host: hostOf(url),
    type: str(root.namedCredentialType),
    protocol: str(root.protocol),
    principalType: str(root.principalType),
    authProvider: provider && NAME.test(provider) ? provider : undefined,
    calloutStatus: str(root.calloutStatus),
  });
  return { type: "NamedCredential", name, label: str(root.label), file, attrs, refs, text: "" };
}

/**
 * An external credential: how it authenticates, and the auth provider it uses (`references`,
 * when the project has it: an org's auth providers are not retrieved, as they hold a secret).
 * No parameter value but a provider's name is kept.
 */
export function readExternalCredential(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const principals: string[] = [];
  for (const p of list(root.externalCredentialParameters).map(obj)) {
    const type = str(p.parameterType);
    const provider = str(p.authProvider);
    if (type === "AuthProvider" && provider && NAME.test(provider)) refs.push({ kind: "references", type: "AuthProvider", name: provider, known: true });
    if (type === "NamedPrincipal" || type === "PerUserPrincipal") principals.push(type);
  }
  const providers = refs.map((r) => ("name" in r ? r.name : "")).filter(Boolean);
  const attrs = withAttrs({ protocol: str(root.authenticationProtocol), authProvider: providers.length ? [...new Set(providers)].sort().join(", ") : undefined, principals: [...new Set(principals)].sort() });
  return { type: "ExternalCredential", name, label: str(root.label), file, attrs, refs, text: joinText(str(root.description)) };
}

/** A remote site setting: the host Apex may call without a named credential. */
export function readRemoteSiteSetting(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const attrs = withAttrs({ host: hostOf(str(root.url)), active: bool(root.isActive), protocolSecurityDisabled: bool(root.disableProtocolSecurity) });
  return { type: "RemoteSiteSetting", name, file, attrs, refs: [], text: joinText(str(root.description)) };
}

/**
 * A connected app: its OAuth scopes and callback hosts. Its consumer key, secret,
 * certificate and contact email are never kept.
 */
export function readConnectedApp(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const oauth = obj(root.oauthConfig);
  const hosts = new Set<string>();
  for (const line of (str(oauth.callbackUrl) ?? "").split(/[\s,]+/)) {
    const host = hostOf(line);
    if (host) hosts.add(host);
  }
  const scopes = list(oauth.scopes).map(str).filter((s): s is string => !!s);
  const policies = obj(root.oauthPolicy);
  const attrs = withAttrs({
    scopes: [...new Set(scopes)].sort(),
    callbackHosts: [...hosts].sort(),
    oauth: Object.keys(oauth).length > 0,
    canvas: Object.keys(obj(root.canvasConfig)).length > 0 || undefined,
    saml: Object.keys(obj(root.samlConfig)).length > 0 || undefined,
    ipRelaxation: str(policies.ipRelaxation),
    refreshTokenPolicy: str(policies.refreshTokenPolicy),
  });
  return { type: "ConnectedApp", name, label: str(root.label), file, attrs, refs: [], text: joinText(str(root.description)) };
}

/**
 * An external service: the named credential it calls through (`references`) and its
 * operations by name. Its schema is not kept.
 */
export function readExternalService(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const credential = str(root.namedCredentialReference) ?? str(root.namedCredential);
  if (credential && NAME.test(credential)) refs.push({ kind: "references", type: "NamedCredential", name: credential });
  const operations = list(root.operations)
    .map((o) => str(obj(o).name))
    .filter((o): o is string => !!o);
  const attrs = withAttrs({ schemaType: str(root.schemaType), status: str(root.status), operations: [...new Set(operations)].sort() });
  return { type: "ExternalServiceRegistration", name, label: str(root.label), file, attrs, refs, text: joinText(str(root.description)) };
}

/** A platform event channel: events or change data capture. */
export function readPlatformEventChannel(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  return { type: "PlatformEventChannel", name, label: str(root.label), file, attrs: withAttrs({ channelType: str(root.channelType) }), refs: [], text: "" };
}

/**
 * A platform event channel member: part of its channel, it reads (publishes) its event or
 * change event. Salesforce's own channel for change events (ChangeEvents) is not linked.
 */
export function readPlatformEventChannelMember(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const channel = str(root.eventChannel);
  if (channel && NAME.test(channel) && channel !== "ChangeEvents") refs.push({ kind: "part_of", type: "PlatformEventChannel", name: channel });
  const entity = str(root.selectedEntity);
  if (entity && NAME.test(entity)) refs.push({ kind: "reads", object: entity });
  return { type: "PlatformEventChannelMember", name, file, attrs: withAttrs({ channel, entity }), refs, text: "" };
}

/**
 * An outbound message ("Account.Notify_ERP"), part of its object's workflow: its endpoint's
 * host and the fields it sends. The integration user it runs as (a username) is not kept.
 */
export function readOutboundMessage(object: string, short: string, m: Record<string, unknown>, file: string): ParsedComponent {
  const fields = list(m.fields).map(str).filter((f): f is string => !!f && NAME.test(f));
  return {
    type: "WorkflowOutboundMessage",
    name: `${object}.${short}`,
    parent: object,
    parentType: "Workflow",
    label: str(m.name),
    file,
    attrs: withAttrs({ host: hostOf(str(m.endpointUrl)), fields: [...new Set(fields)].sort(), includeSessionId: bool(m.includeSessionId) }),
    refs: fields.map((f) => ({ kind: "reads" as const, object, path: f })),
    text: joinText(str(m.description)),
  };
}

/**
 * A workflow file ("Account"): the workflow itself, by name, and each outbound message written
 * in it. Messages in their own files (workflows/Account/workflowOutboundMessages/) are read
 * by readOutboundMessage alone.
 */
export function readWorkflow(object: string, root: Record<string, unknown>, file: string): ParsedComponent[] {
  const out: ParsedComponent[] = [{ type: "Workflow", name: object, file, attrs: {}, text: "" }];
  for (const m of list(root.outboundMessages).map(obj)) {
    const short = str(m.fullName);
    if (short && NAME.test(short)) out.push(readOutboundMessage(object, short, m, file));
  }
  return out;
}
