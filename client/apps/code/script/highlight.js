/**
 * Tiny regex tokenizer for the code editor: document.__highlight(code, language) -> html.
 * One combined regex per language; every rule is a [cssClass, RegExp] pair and must not capture.
 */
(function () {
    var esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var kw = function (words) { return new RegExp('\\b(?:' + words.split(' ').join('|') + ')\\b'); };

    var R = {
        blockC: /\/\*[\s\S]*?(?:\*\/|$)/, lineC: /\/\/[^\n]*/, hash: /#[^\n]*/,
        dq: /"(?:\\.|[^"\\\n])*"?/, sq: /'(?:\\.|[^'\\\n])*'?/, bt: /`(?:\\.|[^`\\])*`?/,
        num: /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/,
        fn: /[A-Za-z_$][\w$]*(?=\s*\()/, type: /\b[A-Z][\w$]*\b/
    };
    var JS_KW = 'async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface let new of package private protected public return static super switch this throw try typeof var void while with yield as type readonly declare namespace abstract';
    var PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case';
    var C_KW = 'abstract as auto bool break case catch char class const continue default defer delete do double else enum extern false final finally float fn for foreach func go goto if impl implements import include inline instanceof int interface let long loop match mod mut namespace new nil null override package private protected pub public range readonly ref register return select self short signed sizeof static string struct super switch template this throw throws trait true try type typedef typename union unsigned use using var virtual void volatile where while yield';
    var SH_KW = 'if then else elif fi for while until do done case esac in function select return exit export local readonly unset source alias echo cd set shift trap';
    var SQL_KW = 'select from where and or not in is null like between join left right inner outer full cross on group by order having limit offset insert into values update set delete create alter drop table index view database primary key foreign references unique default check constraint as distinct union all case when then else end asc desc count sum avg min max exists begin commit rollback';

    var LANGS = {
        js: { flags: 'gm', rules: [['c', R.blockC], ['c', R.lineC], ['s', R.dq], ['s', R.sq], ['s', R.bt], ['v', /\b(?:true|false|null|undefined|NaN|Infinity)\b/], ['k', kw(JS_KW)], ['n', R.num], ['f', R.fn], ['t', R.type]], comment: '//' },
        python: { flags: 'gm', rules: [['s', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/], ['c', R.hash], ['s', R.dq], ['s', R.sq], ['m', /^[ \t]*@[\w.]+/], ['v', /\b(?:True|False|None|self|cls)\b/], ['k', kw(PY_KW)], ['n', R.num], ['f', R.fn], ['t', R.type]], comment: '#' },
        clike: { flags: 'gm', rules: [['c', R.blockC], ['c', R.lineC], ['s', R.dq], ['s', R.sq], ['m', /^[ \t]*#\s*\w+/], ['k', kw(C_KW)], ['n', R.num], ['f', R.fn], ['t', R.type]], comment: '//' },
        sh: { flags: 'gm', rules: [['c', R.hash], ['s', R.dq], ['s', R.sq], ['v', /\$(?:\{[^}\n]*\}|\w+|[?#@*!$])/], ['k', kw(SH_KW)], ['n', R.num]], comment: '#' },
        sql: { flags: 'gmi', rules: [['c', /--[^\n]*/], ['c', R.blockC], ['s', R.sq], ['s', R.dq], ['k', kw(SQL_KW)], ['n', R.num], ['f', R.fn]], comment: '--' },
        json: { flags: 'gm', rules: [['p', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['s', R.dq], ['v', /\b(?:true|false|null)\b/], ['n', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/]], comment: null },
        css: { flags: 'gm', rules: [['c', R.blockC], ['s', R.dq], ['s', R.sq], ['m', /@[\w-]+/], ['p', /[\w-]+(?=\s*:(?!:))/], ['n', /#[\da-fA-F]{3,8}\b/], ['n', /-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/], ['t', /[.#][\w-]+/]], comment: null },
        html: { flags: 'gm', rules: [['c', /<!--[\s\S]*?(?:-->|$)/], ['k', /<\/?[\w:-]+/], ['k', /\/?>/], ['p', /[\w:@.-]+(?==)/], ['s', R.dq], ['s', R.sq]], comment: null },
        md: { flags: 'gm', rules: [['s', /```[\s\S]*?(?:```|$)/], ['k', /^#{1,6}[ \t][^\n]*/], ['c', /^>[^\n]*/], ['s', /`[^`\n]+`/], ['f', /\*\*[^*\n]+\*\*/], ['t', /\[[^\]\n]*\]\([^)\n]*\)/], ['m', /^[ \t]*(?:[-*+]|\d+\.)[ \t]/]], comment: null },
        config: { flags: 'gm', rules: [['c', /(?:^|[ \t])[#;][^\n]*/], ['m', /^\[[^\]\n]+\]/], ['p', /^[ \t-]*[\w."'-]+(?=[ \t]*[:=])/], ['s', R.dq], ['s', R.sq], ['v', /\b(?:true|false|null|yes|no|on|off)\b/], ['n', R.num]], comment: '#' }
    };
    Object.keys(LANGS).forEach(function (k) {
        var l = LANGS[k];
        l.re = new RegExp(l.rules.map(function (r) { return '(' + r[1].source + ')'; }).join('|'), l.flags);
    });

    var BY_EXT = {
        js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', py: 'python', json: 'json', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
        css: 'css', scss: 'css', less: 'css', md: 'md', markdown: 'md', sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql',
        c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike', cs: 'clike', java: 'clike', go: 'clike', rs: 'clike', php: 'clike', kt: 'clike', swift: 'clike',
        yml: 'config', yaml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config', env: 'config'
    };
    var LABEL = { js: 'JavaScript', python: 'Python', json: 'JSON', html: 'HTML', css: 'CSS', md: 'Markdown', sh: 'Shell', sql: 'SQL', clike: 'C-like', config: 'Config', text: 'Plain text' };

    document.__language = function (path) {
        var m = /\.([^./]+)$/.exec(path || '');
        var name = (path || '').split('/').pop();
        if (name === 'Dockerfile' || name === 'Makefile') return 'sh';
        return (m && BY_EXT[m[1].toLowerCase()]) || 'text';
    };
    document.__languageLabel = function (l) { return LABEL[l] || l; };
    document.__commentPrefix = function (l) { return LANGS[l] ? LANGS[l].comment : null; };

    document.__highlight = function (code, language) {
        var l = LANGS[language];
        if (!l) return esc(code);
        var out = '', last = 0, m, re = l.re;
        re.lastIndex = 0;
        while ((m = re.exec(code))) {
            if (m[0] === '') { re.lastIndex++; continue; }
            var g = 1;
            while (g < m.length && m[g] === undefined) g++;
            if (m.index > last) out += esc(code.slice(last, m.index));
            out += '<span class="tok-' + l.rules[g - 1][0] + '">' + esc(m[0]) + '</span>';
            last = re.lastIndex;
        }
        return out + esc(code.slice(last));
    };
})();
