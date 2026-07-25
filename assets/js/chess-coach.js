/* =====================================================================
   Chess Coach — a self-contained interactive chess trainer.
   No external libraries. Full legal move generation (castling,
   en passant, promotion, check/checkmate/stalemate), a clickable +
   draggable board, an opening book with explanations, and a small
   built-in opponent engine (negamax + alpha-beta).
   ===================================================================== */
(function () {
  "use strict";

  /* -------------------- Board model -------------------- */
  // Squares indexed 0..63 with a8=0, b8=1, ... h1=63.
  // row = idx>>3 (0 at top = rank 8), col = idx & 7 (0 = file a).
  var WHITE = "w", BLACK = "b";

  function sq(row, col) { return row * 8 + col; }
  function rowOf(i) { return i >> 3; }
  function colOf(i) { return i & 7; }
  function onBoard(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }
  function algebraic(i) { return "abcdefgh"[colOf(i)] + (8 - rowOf(i)); }
  function fromAlg(s) { return sq(8 - parseInt(s[1], 10), "abcdefgh".indexOf(s[0])); }

  var KNIGHT_D = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  var KING_D   = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  var BISHOP_D = [[-1,-1],[-1,1],[1,-1],[1,1]];
  var ROOK_D   = [[-1,0],[1,0],[0,-1],[0,1]];

  function startPosition() {
    var b = new Array(64).fill(null);
    var back = ["r","n","b","q","k","b","n","r"];
    for (var c = 0; c < 8; c++) {
      b[sq(0, c)] = { t: back[c], c: BLACK };
      b[sq(1, c)] = { t: "p", c: BLACK };
      b[sq(6, c)] = { t: "p", c: WHITE };
      b[sq(7, c)] = { t: back[c], c: WHITE };
    }
    return b;
  }

  function Game() { this.reset(); }

  Game.prototype.reset = function () {
    this.board = startPosition();
    this.turn = WHITE;
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    this.ep = -1;                 // en-passant target square index, or -1
    this.half = 0; this.full = 1;
    this.history = [];            // stack of {move, undo}
  };

  Game.prototype.clone = function () {
    var g = new Game();
    g.board = this.board.map(function (p) { return p ? { t: p.t, c: p.c } : null; });
    g.turn = this.turn;
    g.castling = { wK: this.castling.wK, wQ: this.castling.wQ, bK: this.castling.bK, bQ: this.castling.bQ };
    g.ep = this.ep; g.half = this.half; g.full = this.full;
    g.history = [];
    return g;
  };

  Game.prototype.kingSquare = function (color) {
    for (var i = 0; i < 64; i++) {
      var p = this.board[i];
      if (p && p.t === "k" && p.c === color) return i;
    }
    return -1;
  };

  // Is square `i` attacked by side `by`?
  Game.prototype.attacked = function (i, by) {
    var r = rowOf(i), c = colOf(i), b = this.board, d, rr, cc, p, k;
    // Pawns
    var dir = (by === WHITE) ? 1 : -1; // white pawns sit "below" and attack upward (row-1)
    // A white pawn on (r+1) attacks (r); black pawn on (r-1) attacks (r).
    var pr = (by === WHITE) ? r + 1 : r - 1;
    for (k = 0; k < 2; k++) {
      cc = c + (k === 0 ? -1 : 1);
      if (onBoard(pr, cc)) { p = b[sq(pr, cc)]; if (p && p.c === by && p.t === "p") return true; }
    }
    // Knights
    for (d = 0; d < 8; d++) {
      rr = r + KNIGHT_D[d][0]; cc = c + KNIGHT_D[d][1];
      if (onBoard(rr, cc)) { p = b[sq(rr, cc)]; if (p && p.c === by && p.t === "n") return true; }
    }
    // King
    for (d = 0; d < 8; d++) {
      rr = r + KING_D[d][0]; cc = c + KING_D[d][1];
      if (onBoard(rr, cc)) { p = b[sq(rr, cc)]; if (p && p.c === by && p.t === "k") return true; }
    }
    // Bishops / Queen (diagonals)
    for (d = 0; d < 4; d++) {
      rr = r + BISHOP_D[d][0]; cc = c + BISHOP_D[d][1];
      while (onBoard(rr, cc)) {
        p = b[sq(rr, cc)];
        if (p) { if (p.c === by && (p.t === "b" || p.t === "q")) return true; break; }
        rr += BISHOP_D[d][0]; cc += BISHOP_D[d][1];
      }
    }
    // Rooks / Queen (orthogonal)
    for (d = 0; d < 4; d++) {
      rr = r + ROOK_D[d][0]; cc = c + ROOK_D[d][1];
      while (onBoard(rr, cc)) {
        p = b[sq(rr, cc)];
        if (p) { if (p.c === by && (p.t === "r" || p.t === "q")) return true; break; }
        rr += ROOK_D[d][0]; cc += ROOK_D[d][1];
      }
    }
    return false;
  };

  Game.prototype.inCheck = function (color) {
    return this.attacked(this.kingSquare(color), color === WHITE ? BLACK : WHITE);
  };

  // Pseudo-legal move generation for the side to move.
  Game.prototype.pseudoMoves = function () {
    var moves = [], b = this.board, me = this.turn, opp = me === WHITE ? BLACK : WHITE;
    for (var i = 0; i < 64; i++) {
      var p = b[i];
      if (!p || p.c !== me) continue;
      var r = rowOf(i), c = colOf(i), rr, cc, d, t;
      if (p.t === "p") {
        var fwd = me === WHITE ? -1 : 1;
        var startRow = me === WHITE ? 6 : 1;
        var promoRow = me === WHITE ? 0 : 7;
        // forward one
        rr = r + fwd;
        if (onBoard(rr, c) && !b[sq(rr, c)]) {
          addPawn(moves, i, sq(rr, c), rr === promoRow);
          // forward two
          if (r === startRow && !b[sq(r + 2 * fwd, c)]) {
            moves.push({ from: i, to: sq(r + 2 * fwd, c), flag: "double" });
          }
        }
        // captures
        for (d = -1; d <= 1; d += 2) {
          cc = c + d; rr = r + fwd;
          if (!onBoard(rr, cc)) continue;
          t = sq(rr, cc);
          if (b[t] && b[t].c === opp) addPawn(moves, i, t, rr === promoRow);
          else if (t === this.ep) moves.push({ from: i, to: t, flag: "ep" });
        }
      } else if (p.t === "n") {
        for (d = 0; d < 8; d++) {
          rr = r + KNIGHT_D[d][0]; cc = c + KNIGHT_D[d][1];
          if (onBoard(rr, cc)) { t = sq(rr, cc); if (!b[t] || b[t].c === opp) moves.push({ from: i, to: t }); }
        }
      } else if (p.t === "k") {
        for (d = 0; d < 8; d++) {
          rr = r + KING_D[d][0]; cc = c + KING_D[d][1];
          if (onBoard(rr, cc)) { t = sq(rr, cc); if (!b[t] || b[t].c === opp) moves.push({ from: i, to: t }); }
        }
        // Castling
        var rank = me === WHITE ? 7 : 0;
        var kSide = me === WHITE ? this.castling.wK : this.castling.bK;
        var qSide = me === WHITE ? this.castling.wQ : this.castling.bQ;
        if (i === sq(rank, 4) && !this.attacked(i, opp)) {
          if (kSide && !b[sq(rank, 5)] && !b[sq(rank, 6)] &&
              !this.attacked(sq(rank, 5), opp) && !this.attacked(sq(rank, 6), opp)) {
            moves.push({ from: i, to: sq(rank, 6), flag: "castleK" });
          }
          if (qSide && !b[sq(rank, 3)] && !b[sq(rank, 2)] && !b[sq(rank, 1)] &&
              !this.attacked(sq(rank, 3), opp) && !this.attacked(sq(rank, 2), opp)) {
            moves.push({ from: i, to: sq(rank, 2), flag: "castleQ" });
          }
        }
      } else {
        var dirs = p.t === "b" ? BISHOP_D : p.t === "r" ? ROOK_D : KING_D;
        for (d = 0; d < dirs.length; d++) {
          rr = r + dirs[d][0]; cc = c + dirs[d][1];
          while (onBoard(rr, cc)) {
            t = sq(rr, cc);
            if (!b[t]) moves.push({ from: i, to: t });
            else { if (b[t].c === opp) moves.push({ from: i, to: t }); break; }
            rr += dirs[d][0]; cc += dirs[d][1];
          }
        }
      }
    }
    return moves;
  };

  function addPawn(moves, from, to, promo) {
    if (promo) {
      ["q", "r", "b", "n"].forEach(function (pr) { moves.push({ from: from, to: to, promo: pr }); });
    } else {
      moves.push({ from: from, to: to });
    }
  }

  // Apply a move (mutates), returning an undo record.
  Game.prototype.makeMove = function (m) {
    var b = this.board, undo = {
      castling: { wK: this.castling.wK, wQ: this.castling.wQ, bK: this.castling.bK, bQ: this.castling.bQ },
      ep: this.ep, half: this.half, full: this.full,
      captured: null, capturedSq: -1, from: m.from, to: m.to,
      moved: { t: b[m.from].t, c: b[m.from].c }, flag: m.flag, promo: m.promo
    };
    var p = b[m.from], me = p.c, opp = me === WHITE ? BLACK : WHITE;

    // Captured piece (normal)
    if (b[m.to]) { undo.captured = b[m.to]; undo.capturedSq = m.to; }

    // En passant capture
    if (m.flag === "ep") {
      var capSq = sq(rowOf(m.from), colOf(m.to));
      undo.captured = b[capSq]; undo.capturedSq = capSq; b[capSq] = null;
    }

    // Move the piece
    b[m.to] = p; b[m.from] = null;

    // Promotion
    if (m.promo) b[m.to] = { t: m.promo, c: me };

    // Castling rook move
    if (m.flag === "castleK") {
      var rk = me === WHITE ? 7 : 0;
      b[sq(rk, 5)] = b[sq(rk, 7)]; b[sq(rk, 7)] = null;
    } else if (m.flag === "castleQ") {
      var rq = me === WHITE ? 7 : 0;
      b[sq(rq, 3)] = b[sq(rq, 0)]; b[sq(rq, 0)] = null;
    }

    // Update castling rights
    if (p.t === "k") {
      if (me === WHITE) { this.castling.wK = this.castling.wQ = false; }
      else { this.castling.bK = this.castling.bQ = false; }
    }
    function clrRook(g, i) {
      if (i === sq(7, 0)) g.castling.wQ = false;
      if (i === sq(7, 7)) g.castling.wK = false;
      if (i === sq(0, 0)) g.castling.bQ = false;
      if (i === sq(0, 7)) g.castling.bK = false;
    }
    clrRook(this, m.from); clrRook(this, m.to);

    // En passant target
    this.ep = (m.flag === "double") ? sq((rowOf(m.from) + rowOf(m.to)) / 2, colOf(m.from)) : -1;

    // Clocks
    this.half = (p.t === "p" || undo.captured) ? 0 : this.half + 1;
    if (me === BLACK) this.full++;
    this.turn = opp;
    return undo;
  };

  Game.prototype.undoMove = function (undo) {
    var b = this.board;
    this.turn = undo.moved.c;
    this.castling = undo.castling; this.ep = undo.ep; this.half = undo.half; this.full = undo.full;
    // Restore moved piece to origin
    b[undo.from] = { t: undo.moved.t, c: undo.moved.c };
    b[undo.to] = null;
    // Restore captured
    if (undo.captured) b[undo.capturedSq] = undo.captured;
    // Undo castling rook
    var me = undo.moved.c;
    if (undo.flag === "castleK") { var rk = me === WHITE ? 7 : 0; b[sq(rk, 7)] = b[sq(rk, 5)]; b[sq(rk, 5)] = null; }
    else if (undo.flag === "castleQ") { var rq = me === WHITE ? 7 : 0; b[sq(rq, 0)] = b[sq(rq, 3)]; b[sq(rq, 3)] = null; }
  };

  // Fully-legal moves.
  Game.prototype.legalMoves = function () {
    var pseudo = this.pseudoMoves(), legal = [], me = this.turn;
    for (var i = 0; i < pseudo.length; i++) {
      var u = this.makeMove(pseudo[i]);
      if (!this.inCheck(me)) legal.push(pseudo[i]);
      this.undoMove(u);
    }
    return legal;
  };

  Game.prototype.legalFrom = function (from) {
    return this.legalMoves().filter(function (m) { return m.from === from; });
  };

  // SAN for a move given current position (before it's played).
  Game.prototype.san = function (m) {
    var b = this.board, p = b[m.from];
    if (m.flag === "castleK") return finishSan(this, m, "O-O");
    if (m.flag === "castleQ") return finishSan(this, m, "O-O-O");
    var piece = p.t === "p" ? "" : p.t.toUpperCase();
    var capture = b[m.to] || m.flag === "ep";
    var s = "";
    if (p.t === "p") {
      if (capture) s += "abcdefgh"[colOf(m.from)] + "x";
      s += algebraic(m.to);
      if (m.promo) s += "=" + m.promo.toUpperCase();
    } else {
      s += piece;
      // Disambiguation
      var others = this.legalMoves().filter(function (x) {
        return x.to === m.to && x.from !== m.from && b[x.from] && b[x.from].t === p.t;
      });
      if (others.length) {
        var sameFile = others.some(function (x) { return colOf(x.from) === colOf(m.from); });
        var sameRank = others.some(function (x) { return rowOf(x.from) === rowOf(m.from); });
        if (!sameFile) s += "abcdefgh"[colOf(m.from)];
        else if (!sameRank) s += (8 - rowOf(m.from));
        else s += algebraic(m.from);
      }
      if (capture) s += "x";
      s += algebraic(m.to);
    }
    return finishSan(this, m, s);
  };

  function finishSan(g, m, s) {
    var u = g.makeMove(m);
    var opp = g.turn;
    if (g.inCheck(opp)) s += g.legalMoves().length === 0 ? "#" : "+";
    g.undoMove(u);
    return s;
  }

  Game.prototype.status = function () {
    var legal = this.legalMoves();
    if (legal.length === 0) return this.inCheck(this.turn) ? "checkmate" : "stalemate";
    if (this.half >= 100) return "draw50";
    // Insufficient material (basic)
    var pieces = this.board.filter(Boolean).map(function (p) { return p.t; });
    if (pieces.length <= 3) {
      var minors = pieces.filter(function (t) { return t === "b" || t === "n"; }).length;
      if (pieces.length === 2 || (pieces.length === 3 && minors === 1)) return "material";
    }
    return this.inCheck(this.turn) ? "check" : "ongoing";
  };

  /* -------------------- Engine (opponent) -------------------- */
  var VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  // Small piece-square nudges (white perspective, a8=0).
  var PST_P = [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10,
    5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0];
  var PST_N = [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30,
    -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50];
  var PST_B = [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10,
    -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20];

  function evaluate(g) {
    var score = 0, b = g.board;
    for (var i = 0; i < 64; i++) {
      var p = b[i];
      if (!p) continue;
      var v = VAL[p.t];
      var idx = p.c === WHITE ? i : 63 - i;
      if (p.t === "p") v += PST_P[idx];
      else if (p.t === "n") v += PST_N[idx];
      else if (p.t === "b") v += PST_B[idx];
      score += p.c === WHITE ? v : -v;
    }
    return score; // + = good for white
  }

  function orderMoves(g, moves) {
    return moves.map(function (m) {
      var s = 0, cap = g.board[m.to];
      if (cap) s += 10 * VAL[cap.t] - VAL[g.board[m.from].t];
      if (m.promo) s += VAL[m.promo];
      return { m: m, s: s };
    }).sort(function (a, b) { return b.s - a.s; }).map(function (x) { return x.m; });
  }

  function negamax(g, depth, alpha, beta, color) {
    if (depth === 0) return color * evaluate(g);
    var moves = g.legalMoves();
    if (moves.length === 0) return g.inCheck(g.turn) ? -100000 + (10 - depth) : 0;
    moves = orderMoves(g, moves);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var u = g.makeMove(moves[i]);
      var val = -negamax(g, depth - 1, -beta, -alpha, -color);
      g.undoMove(u);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // Pick a move at a difficulty level (1=easy .. 3=harder).
  function chooseEngineMove(g, level) {
    var moves = orderMoves(g, g.legalMoves());
    if (moves.length === 0) return null;
    var color = g.turn === WHITE ? 1 : -1;
    var depth = level >= 3 ? 3 : level === 2 ? 2 : 1;
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var u = g.makeMove(moves[i]);
      var val = -negamax(g, depth - 1, -Infinity, Infinity, -color);
      g.undoMove(u);
      scored.push({ m: moves[i], v: val });
    }
    scored.sort(function (a, b) { return b.v - a.v; });
    // On easy, sometimes pick a slightly weaker move for a friendlier game.
    if (level === 1 && scored.length > 2) {
      var near = scored.filter(function (s) { return s.v >= scored[0].v - 60; });
      var pool = near.slice(0, Math.min(3, near.length));
      return pool[Math.floor(pseudoRandom() * pool.length)].m;
    }
    var top = scored.filter(function (s) { return s.v === scored[0].v; });
    return top[Math.floor(pseudoRandom() * top.length)].m;
  }

  var _seed = 123456789;
  function pseudoRandom() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

  /* -------------------- Opening book -------------------- */
  // Each opening is a mainline of UCI moves with per-move coaching notes.
  var OPENINGS = [
    {
      name: "Italian Game", eco: "C50", side: "w",
      idea: "A classic, principled opening. You fight for the center, develop your bishop to its best diagonal aiming at f7, and castle quickly. Great first opening to learn sound development.",
      moves: [
        { uci: "e2e4", note: "1.e4 — take the center and open lines for your bishop and queen." },
        { uci: "e7e5", note: "Black mirrors, staking a claim in the center." },
        { uci: "g1f3", note: "2.Nf3 — develop a knight AND attack the e5 pawn. Every move should do a job." },
        { uci: "b8c6", note: "Black defends e5 with a developing move." },
        { uci: "f1c4", note: "3.Bc4 — the 'Italian' bishop, eyeing the weak f7 square near Black's king." },
        { uci: "g8f6", note: "Black develops and attacks your e4 pawn (the Two Knights Defense)." },
        { uci: "d2d3", note: "4.d3 — solid: supports e4 and opens the c1-bishop. Calm and strong." },
        { uci: "f8c5", note: "Black develops the bishop symmetrically." },
        { uci: "e1g1", note: "5.O-O — castle! King safety first; connect your rooks." }
      ]
    },
    {
      name: "Ruy López (Spanish)", eco: "C60", side: "w",
      idea: "One of the oldest and most respected openings. Bb5 pressures the knight defending e5, creating long-term pressure. Favored at the highest levels for over a century.",
      moves: [
        { uci: "e2e4", note: "1.e4 — the classical center grab." },
        { uci: "e7e5", note: "Black responds symmetrically." },
        { uci: "g1f3", note: "2.Nf3 — develop and hit e5." },
        { uci: "b8c6", note: "Black defends e5." },
        { uci: "f1b5", note: "3.Bb5 — the Ruy López. Pin-like pressure on the c6 knight that guards e5." },
        { uci: "a7a6", note: "The Morphy Defense: 3...a6 questions the bishop immediately." },
        { uci: "b5a4", note: "4.Ba4 — keep the bishop on the a2-g8 diagonal, maintaining pressure." },
        { uci: "g8f6", note: "Black develops and attacks e4." },
        { uci: "e1g1", note: "5.O-O — castle and rely on tactics to hold e4. King safety first." }
      ]
    },
    {
      name: "Sicilian Defense", eco: "B20", side: "b",
      idea: "The most popular answer to 1.e4. Instead of symmetry, Black fights for the center asymmetrically with ...c5, creating rich, unbalanced positions and real winning chances.",
      moves: [
        { uci: "e2e4", note: "White plays 1.e4." },
        { uci: "c7c5", note: "1...c5 — the Sicilian! You strike at d4 from the side instead of copying White." },
        { uci: "g1f3", note: "White develops toward a d4 break." },
        { uci: "d7d6", note: "2...d6 — support a future ...Nf6 and control e5." },
        { uci: "d2d4", note: "White opens the center with 3.d4." },
        { uci: "c5d4", note: "3...cxd4 — capture; you trade a flank pawn for a central one. A key Sicilian idea." },
        { uci: "f3d4", note: "White recaptures." },
        { uci: "g8f6", note: "4...Nf6 — develop and attack e4." },
        { uci: "b1c3", note: "White defends e4 (the Open Sicilian)." },
        { uci: "a7a6", note: "5...a6 — the Najdorf! A flexible move controlling b5 before deciding on a plan." }
      ]
    },
    {
      name: "French Defense", eco: "C00", side: "b",
      idea: "A solid, strategic defense. Black accepts a slightly cramped position for a rock-solid pawn chain and a clear plan of counterattacking White's center with ...c5 and ...f6.",
      moves: [
        { uci: "e2e4", note: "White plays 1.e4." },
        { uci: "e7e6", note: "1...e6 — the French. You prepare ...d5 to challenge the center directly." },
        { uci: "d2d4", note: "White builds the big center." },
        { uci: "d7d5", note: "2...d5 — strike at e4. This is the point of the French." },
        { uci: "b1c3", note: "White defends and develops (3.Nc3)." },
        { uci: "f8b4", note: "3...Bb4 — the Winawer. Pin the knight and pressure e4." },
        { uci: "e4e5", note: "White grabs space with 4.e5, closing the center." },
        { uci: "c7c5", note: "4...c5 — immediately counterattack the base of White's pawn chain." }
      ]
    },
    {
      name: "Queen's Gambit", eco: "D06", side: "w",
      idea: "The premier 1.d4 opening. You offer a wing pawn to deflect Black's center pawn and build a powerful, mobile center. Not a true gambit — you usually regain the pawn.",
      moves: [
        { uci: "d2d4", note: "1.d4 — a solid, space-gaining first move controlling e5 and c5." },
        { uci: "d7d5", note: "Black stakes a symmetric claim in the center." },
        { uci: "c2c4", note: "2.c4 — the Queen's Gambit. Offer the c-pawn to pull Black's d5-pawn away from the center." },
        { uci: "e7e6", note: "2...e6 — the Queen's Gambit Declined: solid, supporting d5." },
        { uci: "b1c3", note: "3.Nc3 — develop and add pressure to d5." },
        { uci: "g8f6", note: "Black develops the knight and guards d5." },
        { uci: "c1g5", note: "4.Bg5 — pin the knight, increasing pressure on d5." },
        { uci: "f8e7", note: "Black breaks the pin and prepares to castle." },
        { uci: "e2e3", note: "5.e3 — open the light-squared bishop and keep a solid structure." }
      ]
    },
    {
      name: "King's Indian Defense", eco: "E60", side: "b",
      idea: "A fighting hypermodern defense. Black lets White build a big center, then fianchettoes the bishop and strikes back with ...e5 or ...c5. Dynamic and great for attacking players.",
      moves: [
        { uci: "d2d4", note: "White plays 1.d4." },
        { uci: "g8f6", note: "1...Nf6 — control e4 without committing pawns yet (hypermodern)." },
        { uci: "c2c4", note: "White grabs more space with 2.c4." },
        { uci: "g7g6", note: "2...g6 — prepare to fianchetto the bishop to g7." },
        { uci: "b1c3", note: "White develops naturally." },
        { uci: "f8g7", note: "3...Bg7 — the King's Indian bishop, aiming along the long diagonal." },
        { uci: "e2e4", note: "White builds the ideal big center." },
        { uci: "d7d6", note: "4...d6 — support a coming ...e5 break." },
        { uci: "g1f3", note: "White develops the knight." },
        { uci: "e8g8", note: "5...O-O — castle; you'll challenge the center next with ...e5." }
      ]
    },
    {
      name: "London System", eco: "D02", side: "w",
      idea: "A reliable, easy-to-learn system for White. You set up the same solid structure against almost anything: d4, Bf4, e3, Nf3, Bd3, c3. Perfect when you want a plan you can trust.",
      moves: [
        { uci: "d2d4", note: "1.d4 — begin the London setup." },
        { uci: "d7d5", note: "Black responds in the center." },
        { uci: "c1f4", note: "2.Bf4 — the key London move: develop the bishop OUTSIDE the pawn chain before playing e3." },
        { uci: "g8f6", note: "Black develops." },
        { uci: "e2e3", note: "3.e3 — solidify the center and open the other bishop." },
        { uci: "e7e6", note: "Black mirrors." },
        { uci: "g1f3", note: "4.Nf3 — develop toward the center." },
        { uci: "f8d6", note: "Black challenges your good bishop." },
        { uci: "f1d3", note: "5.Bd3 — complete the harmonious setup; castling comes next." }
      ]
    },
    {
      name: "Caro-Kann Defense", eco: "B10", side: "b",
      idea: "A solid, dependable defense to 1.e4. Like the French, you challenge the center with ...d5, but here your light-squared bishop gets developed freely — no bad bishop problems.",
      moves: [
        { uci: "e2e4", note: "White plays 1.e4." },
        { uci: "c7c6", note: "1...c6 — the Caro-Kann. Prepare ...d5 while keeping the bishop's diagonal open." },
        { uci: "d2d4", note: "White builds a center." },
        { uci: "d7d5", note: "2...d5 — challenge e4 immediately." },
        { uci: "b1c3", note: "White defends e4." },
        { uci: "d5e4", note: "3...dxe4 — capture; you'll develop comfortably afterward." },
        { uci: "c3e4", note: "White recaptures." },
        { uci: "c8f5", note: "4...Bf5 — develop the light-squared bishop actively BEFORE ...e6 locks it in. The whole point of the Caro." }
      ]
    }
  ];

  /* -------------------- UI -------------------- */
  var GLYPH = {
    w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
    b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" }
  };

  var game = new Game();
  var boardEl, statusEl, coachEl, movesEl;
  var flipped = false;          // board orientation (true = black at bottom)
  var humanColor = WHITE;
  var mode = "trainer";         // "trainer" | "play"
  var engineLevel = 2;
  var selected = -1;
  var legalCache = [];
  var currentOpening = null;
  var bookIndex = 0;            // how many book moves have been played
  var pendingPromotion = null;  // {from,to,ok}
  var lastMove = null;

  function el(id) { return document.getElementById(id); }

  function init() {
    boardEl = el("cc-board");
    statusEl = el("cc-status");
    coachEl = el("cc-coach");
    movesEl = el("cc-moves");
    buildBoard();
    wireControls();
    populateOpenings();
    newGame();
  }

  function buildBoard() {
    boardEl.innerHTML = "";
    for (var i = 0; i < 64; i++) {
      var d = document.createElement("div");
      d.className = "cc-sq " + (((rowOf(i) + colOf(i)) % 2 === 0) ? "cc-light" : "cc-dark");
      d.dataset.idx = i;
      d.addEventListener("click", onSquareClick);
      // Drag & drop
      d.addEventListener("dragover", function (e) { e.preventDefault(); });
      d.addEventListener("drop", onDrop);
      boardEl.appendChild(d);
    }
  }

  function wireControls() {
    el("cc-mode").addEventListener("change", function (e) {
      mode = e.target.value;
      el("cc-opening-wrap").style.display = mode === "trainer" ? "" : "none";
      el("cc-level-wrap").style.display = mode === "play" ? "" : "none";
      newGame();
    });
    el("cc-opening").addEventListener("change", newGame);
    el("cc-color").addEventListener("change", function (e) {
      humanColor = e.target.value === "b" ? BLACK : WHITE;
      flipped = humanColor === BLACK;
      newGame();
    });
    el("cc-level").addEventListener("change", function (e) { engineLevel = parseInt(e.target.value, 10); });
    el("cc-new").addEventListener("click", newGame);
    el("cc-undo").addEventListener("click", undo);
    el("cc-flip").addEventListener("click", function () { flipped = !flipped; render(); });
    el("cc-hint").addEventListener("click", showHint);
  }

  function populateOpenings() {
    var sel = el("cc-opening");
    OPENINGS.forEach(function (o, i) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = o.name + " (" + (o.side === "w" ? "White" : "Black") + ")";
      sel.appendChild(opt);
    });
  }

  function newGame() {
    game.reset();
    selected = -1; lastMove = null; pendingPromotion = null;
    if (mode === "trainer") {
      currentOpening = OPENINGS[parseInt(el("cc-opening").value, 10)];
      // In trainer mode the human plays the opening's side.
      humanColor = currentOpening.side === "w" ? WHITE : BLACK;
      el("cc-color").value = humanColor;
      flipped = humanColor === BLACK;
      bookIndex = 0;
      coach(
        "<strong>" + currentOpening.name + "</strong> <span class='cc-eco'>" + currentOpening.eco + "</span><br>" +
        currentOpening.idea +
        "<br><br>You are playing <strong>" + (humanColor === WHITE ? "White" : "Black") +
        "</strong>. Follow the highlighted book moves — I'll explain each one and play the replies."
      );
    } else {
      currentOpening = null; bookIndex = 0;
      humanColor = el("cc-color").value === "b" ? BLACK : WHITE;
      flipped = humanColor === BLACK;
      coach("<strong>Free play vs. Computer.</strong> You're " +
        (humanColor === WHITE ? "White" : "Black") +
        ". Make your moves on the board. I'll name the opening as it takes shape. Good luck!");
    }
    render();
    maybeEngineMove();
  }

  function coach(html) { coachEl.innerHTML = html; }

  function render() {
    var cells = boardEl.children;
    for (var i = 0; i < 64; i++) {
      var idx = flipped ? 63 - i : i;
      var cell = cells[i];
      cell.dataset.idx = idx;
      cell.className = "cc-sq " + (((rowOf(idx) + colOf(idx)) % 2 === 0) ? "cc-light" : "cc-dark");
      var p = game.board[idx];
      cell.innerHTML = "";
      if (p) {
        var span = document.createElement("span");
        span.className = "cc-piece cc-" + p.c;
        span.textContent = GLYPH[p.c][p.t];
        span.draggable = (p.c === humanColor && p.c === game.turn && !isGameOver());
        span.addEventListener("dragstart", onDragStart);
        cell.appendChild(span);
      }
      // Coordinate labels
      if (colOf(idx) === (flipped ? 7 : 0)) addLabel(cell, (8 - rowOf(idx)), "rank");
      if (rowOf(idx) === (flipped ? 0 : 7)) addLabel(cell, "abcdefgh"[colOf(idx)], "file");
    }
    // Highlights
    if (lastMove) {
      markSquare(lastMove.from, "cc-last");
      markSquare(lastMove.to, "cc-last");
    }
    if (selected >= 0) {
      markSquare(selected, "cc-selected");
      legalCache.forEach(function (m) {
        markSquare(m.to, game.board[m.to] || m.flag === "ep" ? "cc-capture" : "cc-target");
      });
    }
    if (game.inCheck(game.turn)) markSquare(game.kingSquare(game.turn), "cc-check");
    // In trainer mode, show the next book move to guide the student.
    if (mode === "trainer" && currentOpening && bookIndex < currentOpening.moves.length &&
        game.turn === humanColor && selected < 0) {
      var bm = currentOpening.moves[bookIndex];
      markSquare(fromAlg(bm.uci.slice(0, 2)), "cc-book");
      markSquare(fromAlg(bm.uci.slice(2, 4)), "cc-book");
    }
    updateStatus();
    renderMoves();
  }

  function addLabel(cell, text, kind) {
    var l = document.createElement("span");
    l.className = "cc-label cc-label-" + kind;
    l.textContent = text;
    cell.appendChild(l);
  }

  function markSquare(idx, cls) {
    var visual = flipped ? 63 - idx : idx;
    if (visual >= 0 && visual < 64) boardEl.children[visual].classList.add(cls);
  }

  function isGameOver() {
    var s = game.status();
    return s === "checkmate" || s === "stalemate" || s === "draw50" || s === "material";
  }

  function updateStatus() {
    var s = game.status();
    var turnTxt = game.turn === WHITE ? "White" : "Black";
    var cls = "cc-badge";
    var txt;
    if (s === "checkmate") { txt = "Checkmate — " + (game.turn === WHITE ? "Black" : "White") + " wins!"; cls += " cc-badge-end"; }
    else if (s === "stalemate") { txt = "Stalemate — draw."; cls += " cc-badge-end"; }
    else if (s === "draw50") { txt = "Draw (50-move rule)."; cls += " cc-badge-end"; }
    else if (s === "material") { txt = "Draw — insufficient material."; cls += " cc-badge-end"; }
    else if (s === "check") { txt = turnTxt + " to move — Check!"; cls += " cc-badge-check"; }
    else { txt = turnTxt + " to move"; }
    statusEl.className = cls;
    statusEl.textContent = txt;
  }

  function renderMoves() {
    var html = "";
    for (var i = 0; i < game.history.length; i += 2) {
      var no = (i / 2) + 1;
      var w = game.history[i] ? game.history[i].san : "";
      var b = game.history[i + 1] ? game.history[i + 1].san : "";
      html += "<span class='cc-move-no'>" + no + ".</span> <span class='cc-move'>" + w + "</span> " +
              (b ? "<span class='cc-move'>" + b + "</span> " : "");
    }
    movesEl.innerHTML = html || "<span class='cc-muted'>No moves yet.</span>";
    movesEl.scrollTop = movesEl.scrollHeight;
  }

  /* ----- interaction ----- */
  function onSquareClick(e) {
    if (pendingPromotion) return;
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    handleSelect(idx);
  }

  function handleSelect(idx) {
    if (game.turn !== humanColor || isGameOver()) return;
    var p = game.board[idx];
    if (selected < 0) {
      if (p && p.c === humanColor) { selected = idx; legalCache = game.legalFrom(idx); render(); }
      return;
    }
    if (idx === selected) { selected = -1; legalCache = []; render(); return; }
    // Try to move
    var m = legalCache.find(function (x) { return x.to === idx; });
    if (m) { attemptMove(m); return; }
    // Reselect
    if (p && p.c === humanColor) { selected = idx; legalCache = game.legalFrom(idx); render(); }
    else { selected = -1; legalCache = []; render(); }
  }

  var dragFrom = -1;
  function onDragStart(e) {
    if (game.turn !== humanColor || isGameOver()) { e.preventDefault(); return; }
    var idx = parseInt(e.currentTarget.parentNode.dataset.idx, 10);
    dragFrom = idx; selected = idx; legalCache = game.legalFrom(idx); render();
    try { e.dataTransfer.setData("text/plain", String(idx)); } catch (err) {}
  }
  function onDrop(e) {
    e.preventDefault();
    if (dragFrom < 0) return;
    var to = parseInt(e.currentTarget.dataset.idx, 10);
    var m = legalCache.find(function (x) { return x.to === to; });
    dragFrom = -1;
    if (m) attemptMove(m); else { selected = -1; legalCache = []; render(); }
  }

  function attemptMove(m) {
    // Promotion — collect all promo options for this from/to.
    var promos = legalCache.filter(function (x) { return x.to === m.to && x.promo; });
    if (promos.length) { askPromotion(m.from, m.to, promos); return; }
    playHuman(m);
  }

  function askPromotion(from, to, promos) {
    pendingPromotion = { from: from, to: to };
    var overlay = el("cc-promo");
    overlay.innerHTML = "";
    var box = document.createElement("div");
    box.className = "cc-promo-box";
    var title = document.createElement("div");
    title.className = "cc-promo-title"; title.textContent = "Promote to:";
    box.appendChild(title);
    ["q", "r", "b", "n"].forEach(function (t) {
      var btn = document.createElement("button");
      btn.className = "cc-promo-btn";
      btn.innerHTML = GLYPH[humanColor][t];
      btn.addEventListener("click", function () {
        var chosen = promos.find(function (x) { return x.promo === t; });
        pendingPromotion = null; overlay.style.display = "none";
        playHuman(chosen);
      });
      box.appendChild(btn);
    });
    overlay.appendChild(box);
    overlay.style.display = "flex";
  }

  function pushHistory(m) {
    var sanStr = game.san(m);
    var undo = game.makeMove(m);
    game.history.push({ move: m, undo: undo, san: sanStr });
    lastMove = m;
  }

  function playHuman(m) {
    var wasBook = false, note = null;
    if (mode === "trainer" && currentOpening && bookIndex < currentOpening.moves.length) {
      var expected = currentOpening.moves[bookIndex];
      if (uciOf(m) === expected.uci) { wasBook = true; note = expected.note; }
    }
    pushHistory(m);
    selected = -1; legalCache = [];

    if (mode === "trainer" && currentOpening) {
      if (wasBook) {
        bookIndex++;
        var extra = "";
        if (bookIndex >= currentOpening.moves.length) {
          extra = "<br><br>🎓 <strong>Book complete!</strong> You've reached the end of the main line. " +
            "Keep playing — I'll now respond as the computer so you can practice the resulting middlegame.";
        }
        coach("✅ <strong>" + game.history[game.history.length - 1].san + "</strong> — " + note + extra);
      } else {
        coach("🤔 That's a legal move, but it leaves the <strong>" + currentOpening.name +
          "</strong> main line. The highlighted squares show the book move. " +
          "Press <em>Undo</em> to try the theory move, or keep playing to explore.");
      }
    } else {
      commentFreePlay();
    }
    render();
    if (!isGameOver()) window.setTimeout(maybeEngineMove, 250);
    else announceEnd();
  }

  function maybeEngineMove() {
    if (game.turn === humanColor || isGameOver()) return;
    // Trainer mode: play the book reply if we're still in the line.
    if (mode === "trainer" && currentOpening && bookIndex < currentOpening.moves.length) {
      var expected = currentOpening.moves[bookIndex];
      var bm = uciToMove(expected.uci);
      if (bm) {
        pushHistory(bm);
        bookIndex++;
        var followUp = "";
        if (bookIndex < currentOpening.moves.length) {
          followUp = " Your turn — the highlighted squares show your next book move.";
        } else {
          followUp = "<br><br>🎓 <strong>That completes the main line!</strong> Play on and I'll respond as the computer.";
        }
        coach("↩️ I played <strong>" + game.history[game.history.length - 1].san + "</strong>. " +
          expected.note + followUp);
        render();
        if (isGameOver()) announceEnd();
        return;
      }
    }
    // Otherwise the engine thinks.
    window.setTimeout(function () {
      var m = chooseEngineMove(game, engineLevel);
      if (!m) { render(); announceEnd(); return; }
      pushHistory(m);
      if (mode === "play") commentFreePlay();
      render();
      if (isGameOver()) announceEnd();
    }, 200);
  }

  function commentFreePlay() {
    var name = detectOpening();
    if (name) {
      coach("📖 This looks like the <strong>" + name + "</strong>. " +
        "Keep developing your pieces, control the center, and castle early!");
    }
  }

  // Detect a known opening from the move list (by UCI prefix match).
  function detectOpening() {
    var played = game.history.map(function (h) { return uciOf(h.move); });
    var best = null, bestLen = 1;
    OPENINGS.forEach(function (o) {
      var n = 0;
      for (var i = 0; i < o.moves.length && i < played.length; i++) {
        if (o.moves[i].uci === played[i]) n++; else break;
      }
      if (n >= 2 && n > bestLen - 1) { best = o.name; bestLen = n; }
    });
    return best;
  }

  function undo() {
    if (game.history.length === 0) return;
    // Undo back to the human's turn (undo engine move + human move if needed).
    popOne();
    if (game.history.length > 0 && game.turn !== humanColor) popOne();
    // Recompute book index in trainer mode.
    if (mode === "trainer" && currentOpening) recomputeBookIndex();
    selected = -1; legalCache = []; pendingPromotion = null;
    lastMove = game.history.length ? game.history[game.history.length - 1].move : null;
    render();
  }

  function popOne() {
    var last = game.history.pop();
    if (last) game.undoMove(last.undo);
  }

  function recomputeBookIndex() {
    bookIndex = 0;
    var played = game.history.map(function (h) { return uciOf(h.move); });
    for (var i = 0; i < currentOpening.moves.length && i < played.length; i++) {
      if (currentOpening.moves[i].uci === played[i]) bookIndex++; else break;
    }
  }

  function showHint() {
    if (isGameOver() || game.turn !== humanColor) return;
    if (mode === "trainer" && currentOpening && bookIndex < currentOpening.moves.length) {
      var bm = currentOpening.moves[bookIndex];
      selected = fromAlg(bm.uci.slice(0, 2));
      legalCache = game.legalFrom(selected);
      render();
      coach("💡 <strong>Hint:</strong> " + bm.note);
      return;
    }
    // Free play hint: suggest the engine's top move for the human.
    var m = chooseEngineMove(game, 3);
    if (m) {
      selected = m.from; legalCache = game.legalFrom(m.from); render();
      coach("💡 <strong>Hint:</strong> A strong move here is <strong>" + game.san(m) + "</strong>.");
    }
  }

  function announceEnd() {
    var s = game.status();
    if (s === "checkmate") {
      var winner = game.turn === WHITE ? "Black" : "White";
      var youWon = (winner === "White" && humanColor === WHITE) || (winner === "Black" && humanColor === BLACK);
      coach((youWon ? "🏆 <strong>Checkmate — you win!</strong> " : "♟️ <strong>Checkmate — the computer wins.</strong> ") +
        "Well played. Hit <em>New Game</em> to go again.");
    } else if (s === "stalemate") {
      coach("🤝 <strong>Stalemate</strong> — it's a draw. No legal moves, but the king isn't in check.");
    } else if (s === "draw50" || s === "material") {
      coach("🤝 <strong>Draw.</strong> " + (s === "material" ? "Not enough material to checkmate." : "50-move rule reached."));
    }
    render();
  }

  /* ----- helpers ----- */
  function uciOf(m) {
    return algebraic(m.from) + algebraic(m.to) + (m.promo ? m.promo : "");
  }
  function uciToMove(uci) {
    var from = fromAlg(uci.slice(0, 2)), to = fromAlg(uci.slice(2, 4));
    var promo = uci.length > 4 ? uci[4] : null;
    return game.legalMoves().find(function (m) {
      return m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo);
    }) || null;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
