/**
 * Checks RENDERED Advanced PDF/HTML markup (FreeMarker already applied) for resources BFO would fetch from outside
 * NetSuite. Checking the template source cannot work: FreeMarker can build any address at render time. After
 * rendering, every address is plain text, so this check sees exactly what BFO will see.
 *
 * Allowed: relative addresses (resolved against the NetSuite account), fragments, data: URIs, http(s) addresses on
 * netsuite.com, and NetSuite's own font files. ${nsfont.*} renders to a file: path on the NetSuite server (seen live:
 * file:///opt/deploy/netledger-all/netledger/WEB-INF/fonts/NotoSans-Regular.ttf); the caller passes that folder as
 * options.fontDirectory, learned at run time, and only a plain .ttf/.otf name directly inside it is allowed. Any other
 * file: address could put a server file into the PDF and is refused. Also refused: any other host, userinfo in an
 * address, other schemes, CSS @import, and DTD entity declarations. No NetSuite modules, so it can be unit-tested
 * outside NetSuite.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define([], () => {
  const ALLOWED_HOST = /(^|\.)netsuite\.com$/i;
  /** Attributes whose value is fetched or followed as an address. */
  const ADDRESS_ATTRIBUTES = new Set([
    'src', 'src-bold', 'src-italic', 'src-bolditalic', 'href', 'xlink:href', 'background', 'background-image', 'data',
    'codebase', 'action', 'poster', 'lowsrc',
    'dynsrc', 'longdesc', 'cite', 'profile', 'usemap', 'classid', 'archive',
  ]);
  const MAX_ISSUES = 10;

  const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  /** XML character references and the five predefined entities, as the XML parser decodes them before BFO. */
  const decodeXml = (text) =>
    text
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&(lt|gt|quot|apos|amp);/g, (_, n) => NAMED[n]);

  /** CSS escapes (\75 or \u) decoded, so \75 rl( reads as url(. */
  const decodeCss = (text) =>
    text.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');

  const FONT_FILE = /^[A-Za-z0-9_-]+\.(?:ttf|otf)$/;

  /** True for a NetSuite font file: a plain .ttf/.otf name directly inside the font folder the caller learned. */
  const isNetSuiteFont = (address, fontDirectory) => {
    if (!fontDirectory || !address.startsWith(`${fontDirectory}/`)) return false;
    return FONT_FILE.test(address.slice(fontDirectory.length + 1));
  };

  /** An issue for one address, or undefined when BFO may fetch it. */
  const addressIssue = (raw, options = {}) => {
    const address = raw.trim();
    if (address === '' || address.startsWith('#')) return undefined;
    if (/^data:/i.test(address)) return undefined;
    if (isNetSuiteFont(address, options.fontDirectory)) return undefined;
    const absolute = /^(?:(https?):)?\/\/([^/?#\\]*)/i.exec(address);
    if (absolute) {
      const authority = absolute[2];
      if (authority.includes('@')) return `address with a user part: ${address.slice(0, 80)}`;
      const host = authority.replace(/:[0-9]*$/, '').toLowerCase();
      return ALLOWED_HOST.test(host) ? undefined : `address outside NetSuite: ${host || '(empty host)'}`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(address)) return `address scheme not allowed: ${address.slice(0, 40)}`;
    // A backslash in place of a slash (https:\\host) is not standard; refuse rather than guess how BFO reads it.
    if (address.includes('\\')) return `address with a backslash: ${address.slice(0, 80)}`;
    return undefined; // relative: resolved against the NetSuite account
  };

  const scanCss = (css, issues, options) => {
    const text = decodeCss(css);
    if (/@import\b/i.test(text)) issues.push('CSS @import is not allowed');
    for (const m of text.matchAll(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi)) {
      const issue = addressIssue(m[2], options);
      if (issue) issues.push(issue);
    }
  };

  /** Issues with rendered markup; an empty list means no resource would be fetched from outside NetSuite. */
  const renderedResourceIssues = (markup, options = {}) => {
    const issues = [];
    if (typeof markup !== 'string') return ['rendered template is not text'];
    if (/<!ENTITY/i.test(markup)) issues.push('entity declarations are not allowed');
    // Start tags, with quoted attribute values that may contain ">".
    for (const tag of markup.matchAll(/<[A-Za-z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      for (const attr of tag[0].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        const name = attr[1].toLowerCase();
        const value = decodeXml(attr[2] ?? attr[3] ?? attr[4] ?? '');
        if (name === 'style') {
          scanCss(value, issues, options);
        } else if (ADDRESS_ATTRIBUTES.has(name) || /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)) {
          const issue = addressIssue(value, options);
          if (issue) issues.push(`${name}: ${issue}`);
        }
      }
    }
    for (const style of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      scanCss(decodeXml(style[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')), issues, options);
    }
    return [...new Set(issues)].slice(0, MAX_ISSUES);
  };

  /**
   * The folder ${nsfont.*} renders into, from the rendered output of a fixed probe template (not the agent's), or
   * undefined when it does not look like a plain absolute file: folder. Without it, no file: address is allowed.
   */
  const fontDirectoryFrom = (rendered) => {
    const m = /(file:\/\/\/[A-Za-z0-9_\-/]+)\/[A-Za-z0-9_-]+\.(?:ttf|otf)/.exec(typeof rendered === 'string' ? rendered : '');
    if (!m || m[1].split('/').some((part) => part === '.' || part === '..')) return undefined;
    return m[1];
  };

  return { renderedResourceIssues, addressIssue, fontDirectoryFrom };
});
