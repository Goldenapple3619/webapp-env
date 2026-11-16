var __grid = (() => {
    function key(c, r) { return c + ',' + r; }
    function valid(cell, rows) { return cell && Number.isInteger(cell.c) && Number.isInteger(cell.r) && cell.c >= 0 && cell.r >= 0 && cell.r < rows; }

    function firstFree(taken, rows, from) {
        for (var c = from ? from.c : 0; c < 10000; c++)
            for (var r = (from && c === from.c) ? from.r : 0; r < rows; r++)
                if (!taken.has(key(c, r))) return { c: c, r: r };
        return { c: 0, r: 0 };
    }

    function nearestFree(taken, want, rows, cols) {
        want = { c: Math.max(0, want.c), r: Math.min(Math.max(0, want.r), rows - 1) };
        if (!taken.has(key(want.c, want.r))) return want;
        for (var d = 1; d < 400; d++) {
            for (var dc = -d; dc <= d; dc++) {
                for (var dr = -d; dr <= d; dr++) {
                    if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
                    var c = want.c + dc, r = want.r + dr;
                    if (c < 0 || r < 0 || r >= rows || (cols && c >= Math.max(cols, want.c + 1) + 40)) continue;
                    if (!taken.has(key(c, r))) return { c: c, r: r };
                }
            }
        }
        return firstFree(taken, rows);
    }

    function place(names, saved, rows, cols) {
        saved = saved || {};
        var taken = new Set(), cells = {}, later = [], fresh = [];
        names.forEach(function (name) {
            var s = saved[name];
            if (valid(s, rows) && (!cols || s.c < cols) && !taken.has(key(s.c, s.r))) { cells[name] = { c: s.c, r: s.r }; taken.add(key(s.c, s.r)); }
            else later.push(name);
        });
        later.forEach(function (name) {
            var wasSaved = !!saved[name];
            var cell = firstFree(taken, rows);
            cells[name] = cell;
            taken.add(key(cell.c, cell.r));
            if (!wasSaved) fresh.push(name);
        });
        return { cells: cells, fresh: fresh };
    }

    function arrange(names, rows) {
        var cells = {};
        names.forEach(function (name, i) { cells[name] = { c: Math.floor(i / rows), r: i % rows }; });
        return cells;
    }

    function cellAt(x, y, cw, ch, pad) {
        return { c: Math.max(0, Math.floor((x - pad) / cw)), r: Math.max(0, Math.floor((y - pad) / ch)) };
    }

    function drop(moving, primary, target, fixedCells, rows) {
        var taken = new Set(Object.keys(fixedCells).map(function (n) { return key(fixedCells[n].c, fixedCells[n].r); }));
        var base = moving[primary], out = {};
        var names = Object.keys(moving).sort(function (a, b) { return a === primary ? -1 : b === primary ? 1 : 0; });
        names.forEach(function (name) {
            var want = { c: moving[name].c - base.c + target.c, r: moving[name].r - base.r + target.r };
            var cell = nearestFree(taken, want, rows);
            out[name] = cell;
            taken.add(key(cell.c, cell.r));
        });
        return out;
    }

    return ({ place: place, arrange: arrange, cellAt: cellAt, drop: drop, firstFree: firstFree, nearestFree: nearestFree, key: key });
})();
if (typeof module !== 'undefined') module.exports = __grid;
