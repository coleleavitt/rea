/** One directive of a Content Security Policy, in source order. */
export interface ContentSecurityPolicyDirective {
  readonly name: string;
  readonly sources: readonly string[];
}

/** A directive source or omission that allows a broad set of content. */
export interface ContentSecurityPolicyConcern {
  readonly directive: string;
  readonly source: string | null;
  readonly reason: string;
}

/** Parsed policy; sources containing DYNAMIC_SOURCE are not judged. */
export interface ParsedContentSecurityPolicy {
  readonly directives: readonly ContentSecurityPolicyDirective[];
  readonly concerns: readonly ContentSecurityPolicyConcern[];
}

/** Placeholder for a value computed at runtime inside a policy string. */
export const DYNAMIC_SOURCE = "${…}";

const DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "connect-src",
  "font-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "fenced-frame-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "navigate-to",
  "sandbox",
  "plugin-types",
  "report-uri",
  "report-to",
  "require-trusted-types-for",
  "trusted-types",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
]);
const SCRIPT_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
]);
const STYLE_DIRECTIVES = new Set([
  "style-src",
  "style-src-elem",
  "style-src-attr",
]);
const SOURCE_LIST =
  /-src(?:-elem|-attr)?$|^(?:base-uri|form-action|frame-ancestors)$/u;
const NETWORK_SCHEMES = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "file:",
  "filesystem:",
]);
const SCRIPT_SCHEMES = new Set(["data:", "blob:"]);

/**
 * Parse a serialized policy (CSP Level 3 `;`-separated directives). Returns
 * undefined unless every directive name is a known CSP directive. With
 * `requireMultiple`, a single directive is not enough evidence that arbitrary
 * text is a policy.
 */
export const parseContentSecurityPolicy = (
  text: string,
  requireMultiple: boolean,
): ParsedContentSecurityPolicy | undefined => {
  const directives: ContentSecurityPolicyDirective[] = [];
  for (const part of text.split(";")) {
    const tokens = part
      .trim()
      .split(/[\t\n\f\r ]+/u)
      .filter(Boolean);
    const [rawName, ...sources] = tokens;
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    if (!DIRECTIVES.has(name)) return undefined;
    directives.push({ name, sources });
  }
  if (directives.length === 0 || (requireMultiple && directives.length < 2))
    return undefined;
  return { directives, concerns: concerns(directives) };
};

const concerns = (
  directives: readonly ContentSecurityPolicyDirective[],
): readonly ContentSecurityPolicyConcern[] => {
  const found: ContentSecurityPolicyConcern[] = [];
  const names = new Set(directives.map(({ name }) => name));
  const dynamic = directives.some(({ sources }) =>
    sources.some((source) => source.includes(DYNAMIC_SOURCE)),
  );
  for (const { name, sources } of directives) {
    if (!SOURCE_LIST.test(name)) continue;
    const lowered = sources.map((source) => source.toLowerCase());
    const nonceOrHash = lowered.some((source) =>
      /^'(?:nonce|sha256|sha384|sha512)-/u.test(source),
    );
    for (const source of lowered) {
      const reason = sourceConcern(name, source, nonceOrHash);
      if (reason !== undefined) found.push({ directive: name, source, reason });
    }
  }
  // Omissions are judged only when every directive value is static.
  if (!dynamic && !names.has("default-src")) {
    if (![...SCRIPT_DIRECTIVES].some((name) => names.has(name)))
      found.push({
        directive: "script-src",
        source: null,
        reason:
          "Neither script-src nor default-src is present, so scripts are unrestricted.",
      });
    if (!names.has("object-src"))
      found.push({
        directive: "object-src",
        source: null,
        reason:
          "Neither object-src nor default-src is present, so plugin content is unrestricted.",
      });
  }
  return found;
};

const sourceConcern = (
  directive: string,
  source: string,
  nonceOrHash: boolean,
): string | undefined => {
  if (source === "*") return "The wildcard source allows any host.";
  if (NETWORK_SCHEMES.has(source))
    return `The scheme source ${source} allows any host with that scheme.`;
  const script = SCRIPT_DIRECTIVES.has(directive);
  if (script && SCRIPT_SCHEMES.has(source))
    return `The scheme source ${source} allows script content from any ${source} URL.`;
  if (
    source === "'unsafe-inline'" &&
    (STYLE_DIRECTIVES.has(directive) || (script && !nonceOrHash))
  )
    return "'unsafe-inline' allows inline content.";
  if (script && source === "'unsafe-eval'")
    return "'unsafe-eval' allows string evaluation.";
  return undefined;
};
