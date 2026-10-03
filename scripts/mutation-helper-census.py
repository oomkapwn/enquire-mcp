#!/usr/bin/env python3
"""DIAGNOSTIC, NOT A GATE. Reproduce two seals from tests/meta-invariant-coverage.test.ts without TypeScript:
  owner hash  = sha256(JSON.stringify({id, source: <whole file>, start: <first non-trivia offset>}))
  call census = sha256(JSON.stringify([{call, callStart, owner, ownerSha256}...])) over replaceExactly calls
Usage: mutation-helper-census.py <file.test.ts> [owner-id ...]   (prints census count+sha, then owner hashes)

READ THIS BEFORE TRUSTING ANY OUTPUT.

Measured 2026-10-02 against the 28 pins in
tests/meta-invariant-coverage.test.ts::EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES:
the CALL COUNT reproduces for all 28, but the DIGEST reproduces for only 23. The five
files listed in KNOWN_DIGEST_DIFFERENCES below return a digest that does NOT match the pin,
even though their count is right.

Consequence: for those five files this tool CANNOT be used to compute a new pin. Copying its
digest into the test would silently replace a reviewed seal with a different value. For the
other 23 it agrees with the pin, which is a genuine cross-implementation check of the seal.

This script is not executed by any CI job. It is here so the reproduction is available and so
the known differences are recorded next to the code that has them. Re-verify against the pins
before trusting any new value.
"""
import json,hashlib,re,sys,io

# Files whose census COUNT reproduces but whose DIGEST does not. Each is a real difference
# between this reproduction and the TypeScript seal, not a known-bad value: do not "fix" a pin
# from this tool's output for these.
KNOWN_DIGEST_DIFFERENCES = frozenset({
    # This file's own seal binds topLevelExecutableOwner rather than the whole file source
    # (tests/meta-invariant-coverage.test.ts, the census construction around line 3323), while
    # owner_hash() below always hashes the whole source. The difference is structural.
    "meta-invariant-coverage.test.ts",
    # Owner resolution differs from the TypeScript expressionReceiverRoot for these four.
    # Root cause not yet localised.
    "docs-consistency.test.ts",
    "enforcement-guard-invariant.test.ts",
    "erasure-invariant.test.ts",
    "pages.test.ts",
})

HELPERS=("replaceExactly","replaceAllExactly","replaceIntegerAllExactly")
def first_token_start(src):
    i=0;n=len(src)
    if src.startswith("#!"):
        j=src.find("\n"); i=n if j<0 else j+1
    while i<n:
        if src[i].isspace(): i+=1; continue
        if src.startswith("//",i):
            j=src.find("\n",i); i=n if j<0 else j+1; continue
        if src.startswith("/*",i):
            j=src.find("*/",i+2); i=n if j<0 else j+2; continue
        break
    return i
def sha(s): return hashlib.sha256(s.encode("utf-8")).hexdigest()
def u16(src,i):
    """TypeScript positions are UTF-16 code UNITS; Python indexes code POINTS.
    Every astral character before an offset shifts it by one. Reproduced against
    main 2026-09-05: without this the census digest was wrong for any file with a
    non-BMP character before a helper call (fts5.test.ts has six)."""
    return len(src[:i].encode("utf-16-le"))//2
def owner_hash(oid,src): return sha(json.dumps({"id":oid,"source":src,"start":u16(src,first_token_start(src))},ensure_ascii=False,separators=(",",":")))
_ID_RE=re.compile(r"[A-Za-z_$]")
_NUM_RE=re.compile(r"[0-9]")
def masked(src):
    m = set()
    n = len(src)
    # last significant code char, used to tell a regex literal from division
    prev = ""

    def note(ch):
        nonlocal prev
        prev = ch

    def _regex_allowed():
        # A '/' begins a regex where an expression may start, not after a value.
        if prev == "":
            return True
        if prev in ")]":
            return False
        if _ID_RE.match(prev) or _NUM_RE.match(prev) or prev in "\"'`":
            return False
        return True

    def code(i, expr=False, depth=0):
        nonlocal prev
        while i < n:
            c = src[i]
            if expr:
                if c == "{":
                    depth += 1; i += 1; continue
                if c == "}":
                    if depth == 0:
                        return i
                    depth -= 1; i += 1; continue
            if c == "/" and i + 1 < n and src[i + 1] == "/":
                j = src.find("\n", i); j = n if j < 0 else j
                m.update(range(i, j)); i = j; continue
            if c == "/" and i + 1 < n and src[i + 1] == "*":
                j = src.find("*/", i + 2); j = n if j < 0 else j + 2
                m.update(range(i, j)); i = j; continue
            if c == "/" and _regex_allowed():
                j = i + 1; cls = False
                while j < n:
                    if src[j] == "\\":
                        j += 2; continue
                    if src[j] == "\n":            # unterminated: not a regex
                        break
                    if src[j] == "[":
                        cls = True
                    elif src[j] == "]":
                        cls = False
                    elif src[j] == "/" and not cls:
                        break
                    j += 1
                if j < n and src[j] == "/":
                    j += 1
                    while j < n and _ID_RE.match(src[j]):
                        j += 1
                    m.update(range(i, j)); i = j; note("/")
                    continue
                i += 1; continue                    # plain division
            if c in "\"'":
                q = c; j = i + 1
                while j < n:
                    if src[j] == "\\":
                        j += 2; continue
                    if src[j] == q:
                        break
                    if src[j] == "\n":             # unterminated
                        break
                    j += 1
                end = min(j + 1, n)
                m.update(range(i, end)); i = end; note(q)
                continue
            if c == "`":
                i = template(i); continue
            if not c.isspace():
                note(c)
            i += 1
        return i

    def template(i):
        nonlocal prev
        m.add(i); prev = "`"
        j = i + 1
        while j < n:
            if src[j] == "\\":
                m.update((j, j + 1)); j += 2; continue
            if src[j] == "`":
                m.add(j); prev = "`"; return j + 1
            if src.startswith("${", j):
                m.update((j, j + 1))
                saved = prev
                k = code(j + 2, expr=True)
                prev = saved
                if k < n and src[k] == "}":
                    m.add(k); j = k + 1; continue
                return n
            m.add(j); j += 1
        return n

    code(0)
    for mm in re.finditer(r"^import\b[^;]*;", src, re.M):
        m.update(range(mm.start(), mm.end()))
    return m
def call_text(src,start):
    i=src.index("(",start); d=0; j=i; q=None
    while j<len(src):
        c=src[j]
        if q:
            if c=="\\": j+=2; continue
            if c==q: q=None
        elif c in "\"'`": q=c
        elif c=="(": d+=1
        elif c==")":
            d-=1
            if d==0: return src[start:j+1]
        j+=1
    raise SystemExit("unbalanced call")
KEYWORDS = frozenset("""
for if while switch catch do else return typeof function try with case default
new await yield delete void in of instanceof implements interface enum
""".split())
_RE_NAMED_FUNCTION = re.compile(r"(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{$", re.S)
_RE_VAR_ARROW = re.compile(r"(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*\{$", re.S)
_RE_PLAIN_ARROW_ARG = re.compile(r"([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`(?!\$\{)[^`]*`)\s*,\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{$", re.S)
_RE_BARE_CALLBACK = re.compile(r"([A-Za-z_$][\w$]*)\s*\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{$", re.S)
_RE_METHODISH = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{$", re.S)
_RE_IDENT_CHAIN = re.compile(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\Z")
_CACHE = {}

def _match_back(src, i, open_ch, close_ch):
    depth = 0
    j = i
    while j >= 0:
        if src[j] == close_ch:
            depth += 1
        elif src[j] == open_ch:
            depth -= 1
            if depth == 0:
                return j
        j -= 1
    return None


def _string_start(src, i):
    q = src[i]
    j = i - 1
    while j >= 0:
        if src[j] == "\\":
            j -= 2
            continue
        if src[j] == q:
            return j
        j -= 1
    return None


def receiver_root(src, end):
    """expressionReceiverRoot for the expression whose LAST character is at `end`."""
    i = end
    while True:
        while i >= 0 and src[i].isspace():
            i -= 1
        if i < 0:
            return None
        c = src[i]
        if c in ")]":
            j = _match_back(src, i, "(" if c == ")" else "[", c)
            if j is None:
                return None
            i = j - 1
            continue
        if c in "\"'`":
            j = _string_start(src, i)
            if j is None:
                return None
            i = j - 1
            continue
        break
    j = i
    while j >= 0 and (src[j].isalnum() or src[j] in "_$."):
        j -= 1
    chain = src[j + 1:i + 1]
    if not _RE_IDENT_CHAIN.fullmatch(chain):
        return None
    if j >= 0 and (src[j] in ")]" or src[j] in "\"'`"):
        return receiver_root(src, j)
    root = chain.split(".")[0]
    return None if root in KEYWORDS else root


def _first_string_literal(src, lo, hi, mk):
    """first string-literal argument of a call, at argument depth 0."""
    depth = 0
    for k in range(lo, hi):
        if k in mk:
            continue
        c = src[k]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0 and c in "\"'`":
            e = _string_start(src, k + 1)
            if e is None:
                return None
            lit = src[k + 1:e]
            if c == "`" and "${" in lit:
                continue          # TemplateExpression is not StringLiteralLike
            return lit
    return None


def _params_close_before_arrow(head, arrow):
    """index of the ')' closing an arrow's parameter list, honouring a return-type annotation.

    A plain arrow puts ')' immediately before '=>', but `(): void =>` does not, and the original
    code required exactly that. Every arrow carrying a return type therefore fell through to
    `anonymous-function` instead of the `it:<title>` owner TypeScript reports. Scanning back, a
    ')' at bracket depth 0 IS the parameter list's close; a ':' at depth 0 starts a return type,
    whose own parens (and even a nested '=>') are skipped to reach that ')'.
    """
    depth = 0
    i = arrow - 1
    while i >= 0:
        c = head[i]
        if c in ")]}":
            if depth == 0:
                return i if c == ")" else None
            depth += 1
        elif c in "([{":
            if depth == 0:
                return None
            depth -= 1
        elif c == ":" and depth == 0:
            j = i - 1
            while j >= 0 and head[j].isspace():
                j -= 1
            return j if j >= 0 and head[j] == ")" else None
        i -= 1
    return None


def _arrow_call_owner(src, head):
    """head = source through an arrow's '{'. Owner id, or None if not that shape."""
    if not head.endswith("{"):
        return None
    arrow = head.rfind("=>", 0, len(head) - 1)
    if arrow < 0 or head[arrow + 2:].strip() != "{":
        return None
    i = _params_close_before_arrow(head, arrow)
    if i is None:
        return None
    j = None
    depth = 0
    q = i
    while q >= 0:
        c = head[q]
        if c == ")":
            depth += 1
        elif c == "(":
            depth -= 1
            if depth == 0:
                j = q
                break
        q -= 1
    if j is None:
        return None
    k = j - 1
    while k >= 0 and head[k].isspace():
        k -= 1
    if k >= 4 and head[k - 4:k + 1] == "async":
        k -= 5
        while k >= 0 and head[k].isspace():
            k -= 1
    if k < 0 or head[k] != ",":
        return None
    k -= 1
    while k >= 0 and head[k].isspace():
        k -= 1
    if k < 0:
        return None
    if head[k] in "\"'`":
        e = _string_start(head, k)
        if e is None:
            return None
        title = head[e + 1:k]
        if head[e] == "`" and "${" in title:
            title = None          # TemplateExpression is not StringLiteralLike (:1758)
        p = e - 1
        while p >= 0 and head[p].isspace():
            p -= 1
        expr_end = p - 1
    else:
        title = None
        p = k - 1
        while p >= 0 and head[p].isspace():
            p -= 1
        expr_end = p - 1
    root = receiver_root(src, expr_end) or "call"
    return f"{root}:{title}" if title is not None else f"callback:{root}"


def _classify(src, opener):
    """(owner, is_function_body) for the block opened at `opener`."""
    head = src[:opener + 1]
    m = _RE_NAMED_FUNCTION.search(head)
    if m:
        return "function:" + m.group(1), True
    m = _RE_VAR_ARROW.search(head)
    if m:
        return "function:" + m.group(1), True
    tail = head.rfind("=>", 0, len(head) - 1)
    if tail >= 0 and head.endswith("{") and head[tail + 2:].strip() == "{":
        got = _arrow_call_owner(src, head)
        return (got if got is not None else "anonymous-function"), True
    m = _RE_PLAIN_ARROW_ARG.search(head)
    if m:
        return f"{m.group(1)}:{m.group(2)[1:-1]}", True
    m = _RE_BARE_CALLBACK.search(head)
    if m and m.group(1) not in KEYWORDS:
        return "callback:" + m.group(1), True
    m = _RE_METHODISH.search(head)
    if m and m.group(1) not in KEYWORDS:
        return "function:" + m.group(1), True
    return None, False


def _enclosing_call_open(src, i, mk):
    """position of the '(' whose argument list contains index i."""
    depth = 0
    j = i - 1
    while j >= 0:
        if j in mk:
            j -= 1
            continue
        c = src[j]
        if c in ")]}":
            depth += 1
        elif c in "([{":
            if depth == 0:
                return j
            depth -= 1
        j -= 1
    return None


def _brace_less_arrow_owner(src, start, mk):
    """`(params) => expr` has no braces, so only a paren walk can see it."""
    depth = 0
    j = start
    floor = max(0, start - 4000)   # a brace-less arrow body is never this long
    while j >= floor:
        if j in mk:
            j -= 1
            continue
        c = src[j]
        if c == ")":
            depth += 1
        elif c == "(":
            if depth == 1:
                close = _match_back(src, j, "(", ")")
                if close is not None and close < start:
                    r = close + 1
                    while r < len(src) and src[r].isspace():
                        r += 1
                    if r < len(src) and src[r] == ":":
                        while r < len(src) and src[r] != "=":
                            r += 1
                    if src[r:r + 2] == "=>":
                        call_open = _enclosing_call_open(src, j, mk)
                        if call_open is None:
                            return None
                        root = receiver_root(src, call_open - 1) or "call"
                        title = _first_string_literal(src, call_open + 1, j, mk)
                        return f"{root}:{title}" if title is not None else f"callback:{root}"
            if depth > 0:
                depth -= 1
        j -= 1
    return None


def _build(src, mk):
    n = len(src)
    top = [-1] * n
    parent = {}
    stack = []
    cur = -1
    for i in range(n):
        if i in mk:
            top[i] = cur
            continue
        c = src[i]
        if c == "{":
            parent[i] = cur
            stack.append(i)
            cur = i
        elif c == "}":
            if stack:
                stack.pop()
            cur = stack[-1] if stack else -1
        top[i] = cur
    return top, parent


def owner_id(src, start, mk=None):
    if mk is None:
        mk = masked(src)
    key = (id(src), id(mk))
    hit = _CACHE.get(key)
    if hit is None:
        hit = _build(src, mk)
        _CACHE[key] = hit
    top, parent = hit
    if start >= len(top):
        return "source-statement"
    got = _brace_less_arrow_owner(src, start, mk)
    if got is not None:
        return got
    opener = top[start]
    while opener is not None and opener >= 0:
        got, is_fn = _classify(src, opener)
        if is_fn:
            return got
        opener = parent.get(opener)
    return "source-statement"
def census(path):
    src=io.open(path,encoding="utf-8").read(); mk=masked(src); recs=[]
    for m in re.finditer(r"\b(%s)\b(?=\s*\()"%"|".join(HELPERS),src):
        s=m.start()
        if s in mk: continue
        oid=owner_id(src,s,mk)
        recs.append({"call":call_text(src,s),"callStart":u16(src,s),"owner":oid,"ownerSha256":owner_hash(oid,src)})
    return len(recs),sha(json.dumps(recs,ensure_ascii=False,separators=(",",":"))),recs
if __name__=="__main__":
    p=sys.argv[1]; src=io.open(p,encoding="utf-8").read()
    n,h,recs=census(p); print(f"census {n} {h}")
    for r in recs: print("   owner:",r["owner"])
    for oid in sys.argv[2:]: print(f"owner {oid!r} {owner_hash(oid,src)}")
    name=p.replace("\\","/").rsplit("/",1)[-1]
    if name in KNOWN_DIGEST_DIFFERENCES:
        print(
            f"WARNING: {name} is a KNOWN_DIGEST_DIFFERENCES entry — its count reproduces but "
            "its digest does not match the reviewed pin. Do NOT use this digest to update a pin.",
            file=sys.stderr
        )
