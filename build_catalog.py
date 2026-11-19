"""產生 data/catalog.json（課堂動畫 App 的目錄樹）。

樹的邏輯照 work/20261118-2257-一對一教學App/build_sketch.py（老師核可的 B 版）：
  首頁 → 科目 → 分組（生物／理化／地科、學測／分科、年級）→ 冊 → 章「第N章 章名」→ 片名（葉子）。

來源（都在 data/）：
  catalog_sample.json  {科目:{資料夾:[片名]}}，國中自然用（Drive「教學動畫備份/國中自然/第N冊第M章/」）
  hs_map.json          高中物理、高中化學的章對照（片名帶 YYYYMMDD_高物_ 前綴，這裡去掉）
  jr_sci_chapters.json 國中自然章名
  math_chapters.json   三個數學科的架構（目前沒有片，只有空章）

新增動畫：更新上面的 json（或重產 catalog_sample.json）後重跑 `python3 build_catalog.py`。
就算沒重跑，App 登入後也會把 Drive 裡有、目錄裡沒有的片放進該科「新上架」。
"""
import json, os, re, unicodedata, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')
ld = lambda f: json.load(open(os.path.join(D, f))) if os.path.exists(os.path.join(D, f)) else None
num = lambda g: [int(x) for x in re.findall(r'\d+', g)] or [0]


def display_name(n):
    """檔名 → 顯示片名：去副檔名、去 YYYYMMDD_高物_ 這類前綴。App 端 app.js 的 displayName() 要跟這裡一致。"""
    n = re.sub(r'\.mp4$', '', n, flags=re.I)
    n = re.sub(r'^\d{8}_[^_]+_', '', n)
    return n.strip()


def jr_part(b, c):
    if b <= 2: return '生物'
    if b == 5 and c >= 5: return '地科'
    if b == 6 and c >= 3: return '地科'   # 第6冊第3、4章（天氣、全球變遷）講義屬地科
    return '理化'


def chap(c, name):
    if not name: return f'第{c}章'
    name = re.sub(r'^第\s*0*\d+\s*章\s*', '', name)
    return f'第{c}章 {name}'


def empty_chapters(lst):
    out = {}
    for i, n in enumerate(lst or [], 1):
        if re.match(r'^第\s*\d+\s*單元', n or ''): out[n] = []; continue
        m = re.match(r'^第\s*0*(\d+)\s*章', n or '')
        out[chap(int(m.group(1)) if m else i, n)] = []
    return out


def build():
    cat = ld('catalog_sample.json') or {}
    hm = ld('hs_map.json') or {}
    jn = ld('jr_sci_chapters.json') or {}
    mc = ld('math_chapters.json') or {}

    tree = {}
    jr = {'生物': {}, '理化': {}, '地科': {}}
    for g in sorted(cat.get('國中自然', {}), key=num):
        b, c = num(g)[:2]
        names = [display_name(x) for x in cat['國中自然'][g]]
        jr[jr_part(b, c)].setdefault(f'第{b}冊', {})[chap(c, (jn.get(str(b)) or {}).get(str(c)))] = names
    # 講義有、動畫還沒有的章（例：第6冊第3、4章）也列出來，顯示「動畫準備中」
    for b, chs in jn.items():
        for c, name in chs.items():
            part = jr[jr_part(int(b), int(c))].setdefault(f'第{b}冊', {})
            part.setdefault(chap(int(c), name), [])
    for part in jr.values():  # 冊、章依數字排序
        for bk in list(part):
            part[bk] = dict(sorted(part[bk].items(), key=lambda kv: num(kv[0])))
        part_sorted = dict(sorted(part.items(), key=lambda kv: num(kv[0])))
        part.clear(); part.update(part_sorted)
    tree['國中自然'] = jr

    for s in ['高中物理', '高中化學']:
        tree[s] = {grp: {chap(num(k)[0], k): [display_name(x) for x in v] for k, v in chs.items()}
                   for grp, chs in (hm.get(s) or {}).items() if grp != '未分類' and chs}

    if mc.get('國小數學'):
        tree['國小數學'] = {k: empty_chapters(v) if v else {} for k, v in mc['國小數學'].items()}
    if mc.get('國中數學'):
        tree['國中數學'] = {f'第{k}冊': empty_chapters(v) for k, v in mc['國中數學'].items()}
    if mc.get('高中數學'):
        tree['高中數學'] = {grp: {sub: empty_chapters(v) for sub, v in subs.items()} for grp, subs in mc['高中數學'].items()}
    for s in ['國小數學', '國中數學', '高中數學']: tree.setdefault(s, {})

    return {
        'built': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'levels': {'國小': ['國小數學'], '國中': ['國中自然', '國中數學'], '高中': ['高中物理', '高中化學', '高中數學']},
        'tree': tree,
    }


def count(n): return len(n) if isinstance(n, list) else sum(count(v) for v in n.values())


if __name__ == '__main__':
    out = build()
    json.dump(out, open(os.path.join(D, 'catalog.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    for s, v in out['tree'].items():
        print(s, count(v), '支', {k: count(x) for k, x in v.items()})
    print('→ data/catalog.json')
