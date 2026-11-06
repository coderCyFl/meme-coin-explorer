"""Executable rank-swap and interaction regression using the production painter."""
import subprocess
import unittest
from pathlib import Path

class GainerIdentityTests(unittest.TestCase):
    def test_rank_swap_preserves_buttons_and_defers_interaction(self):
        source = (Path(__file__).resolve().parents[1] / "js/app.js").read_text()
        painter = source.split("  function paintGainerList(", 1)[1].split("  function renderGainers()", 1)[0]
        js = r"""
const assert = require('assert');
let gPointerDown = false, gInteractionUntil = 0, scheduled = 0;
const document = { activeElement: null };
const S = {selected: null};
const scheduleGainers = () => scheduled++;
const gRowInner = sym => sym;
function row(sym) {
 const button = {dataset: {sym}, _h: sym, classList: {toggle() {}}, innerHTML: sym};
 const li = {querySelector: () => button, remove() {el.children.splice(el.children.indexOf(li), 1)}};
 button.parentElement = li;
 return li;
}
const a = row('A'), b = row('B');
const el = {children: [a,b], dataset: {}, contains: x => x === a.querySelector() || x === b.querySelector(),
 querySelectorAll: () => el.children.map(x => x.querySelector()),
 insertBefore(li, ref) {const old = el.children.indexOf(li); if(old >= 0) el.children.splice(old,1); const i = ref ? el.children.indexOf(ref) : el.children.length; el.children.splice(i,0,li);}
};
""" + "function paintGainerList(" + painter + r"""
const originalButton = a.querySelector();
gPointerDown = true;
paintGainerList(el, ['B','A'], '');
assert.deepStrictEqual(el.children, [a,b]);
gPointerDown = false;
gInteractionUntil = Date.now() + 1000;
paintGainerList(el, ['B','A'], '');
assert.deepStrictEqual(el.children, [a,b]);
gInteractionUntil = 0;
document.activeElement = originalButton;
paintGainerList(el, ['B','A'], '');
assert.deepStrictEqual(el.children, [a,b]);
document.activeElement = null;
paintGainerList(el, ['B','A'], '');
assert.deepStrictEqual(el.children, [b,a]);
assert.strictEqual(a.querySelector(), originalButton);
assert.strictEqual(scheduled, 3);
"""
        subprocess.run(["node", "-e", js], check=True)
