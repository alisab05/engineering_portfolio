/* =========================================================
   SCUTL-style centipede robot, top view, drawn like the lab's
   kinematic plots (thick body line, small joint circles, L-shaped
   legs, filled feet = in ground contact).

   How it moves
   - HEAD-FOLLOWER: the head chases the cursor (turn-rate limited, slows
     as it arrives). Every segment then takes the heading of the path the
     head already travelled, so a turn made by the head propagates down
     the body one segment at a time.
   - UNDULATION: a fixed travelling wave is added on top, the same every
     cycle: a_k(t) = A sin(2*pi*t/T - k*pi/2 - pi/4), i.e. one wave every
     four segments, matching the zig-zag in the lab's t = 0 snapshot.
   - LEGS: each segment has a left and right leg that stays planted
     (stance) for 83% of the cycle and swings forward for 17%, with the
     two sides half a cycle apart, so 10 of 12 legs touch down at any
     moment, like the "contacting legs = 10" plot.

   Illustrative; not a physics simulation of the real robot.
   ========================================================= */
(function () {
  var canvas = document.getElementById('scuttl-canvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var readout = document.getElementById('scuttl-readout');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var N = 6;                 // segments (5 joints)
  var PERIOD = 2.6;          // seconds per wave / gait cycle
  var AMP = 0.45;            // wave amplitude on segment angle (rad)
  var WAVE_LAG = Math.PI / 2;     // wave phase lag per segment (one wave per 4 segments)
  var WAVE_PHASE = -Math.PI / 4;
  var DUTY = 0.83;           // fraction of the gait cycle a leg is planted
  var LEG_LAG = 0.25;        // gait phase lag per segment (fraction of a cycle)
  var TAU = Math.PI * 2;

  var css = getComputedStyle(document.documentElement);
  var ACCENT = css.getPropertyValue('--color-accent').trim() || '#1F4FFF';
  var INK = css.getPropertyValue('--color-text').trim() || '#0A0A0B';

  var w = 0, h = 0, dpr = 1, L = 50, DS = 4;
  var x, y, psi = 0;                 // head point + heading
  var trail = [];                    // newest last: [{x, y}]
  var t = 0;                         // gait clock: only advances while the robot moves
  var clock = 0;                     // wall clock, used for the idle wander
  var speed = 0, arrived = false;    // head speed (px/s) and "parked at the cursor" flag
  var last = 0, running = false, inView = true;
  var pointer = null;

  function wrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
  function frac(v) { return v - Math.floor(v); }

  function resize() {
    var r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L = Math.max(24, Math.min(64, w / 12, h / 4.2));
    DS = L * 0.08;
    if (x === undefined) {
      x = w * 0.6; y = h * 0.74; psi = Math.PI;       // start low in the hero, heading left
      trail = [];
      // Pre-fill a straight tail behind the head so the body starts extended.
      for (var i = Math.ceil(N * L * 1.4 / DS); i >= 0; i--) {
        trail.push({ x: x + Math.cos(psi + Math.PI) * i * DS, y: y + Math.sin(psi + Math.PI) * i * DS });
      }
    }
    if (!running) draw();
  }

  /* Point on the path at arclength s behind the head. The path is the head's
     exact position followed by the recorded trail (newest first), so nothing
     jumps when a new trail sample is added. */
  function pathPoint(s) {
    var px = x, py = y, rem = s;
    for (var i = trail.length - 1; i >= 0; i--) {
      var q = trail[i], d = Math.hypot(q.x - px, q.y - py);
      if (rem <= d) {
        var f = d > 1e-9 ? rem / d : 0;
        return { x: px + (q.x - px) * f, y: py + (q.y - py) * f };
      }
      rem -= d; px = q.x; py = q.y;
    }
    return { x: px, y: py };
  }

  /* Heading of the path (direction of travel) around arclength s */
  function pathHeading(s) {
    var d = L * 0.5;
    var newer = pathPoint(Math.max(0, s - d)), older = pathPoint(s + d);
    var dx = newer.x - older.x, dy = newer.y - older.y;
    return (Math.abs(dx) + Math.abs(dy) < 1e-6) ? psi : Math.atan2(dy, dx);
  }

  /* Segment centres + headings. Each segment takes the head's old path
     heading (propagated turn) plus the fixed undulation wave. */
  function pose() {
    var segs = [], px = x, py = y, prevA = 0;
    for (var k = 0; k < N; k++) {
      var a = pathHeading((k + 0.5) * L) + AMP * Math.sin(TAU * t / PERIOD - k * WAVE_LAG + WAVE_PHASE);
      if (k > 0) {
        px -= (L / 2) * Math.cos(prevA) + (L / 2) * Math.cos(a);
        py -= (L / 2) * Math.sin(prevA) + (L / 2) * Math.sin(a);
      }
      segs.push({ x: px, y: py, a: a });
      prevA = a;
    }
    return segs;
  }

  function targetPoint() {
    var m = L * 0.9;
    if (pointer) {
      return { x: Math.max(m, Math.min(w - m, pointer.x)), y: Math.max(m, Math.min(h - m, pointer.y)) };
    }
    // No cursor seen yet (e.g. a phone): wander until one appears.
    return { x: w * 0.5 + w * 0.3 * Math.cos(clock * 0.35), y: h * 0.5 + h * 0.26 * Math.sin(clock * 0.7) };
  }

  function step(dt) {
    clock += dt;
    var VMAX = L * 3.0;           // cruise speed: constant while the cursor is far away
    var ACC = L * 8.0;            // speed changes smoothly, never instantly
    var STOP_R = L * 0.35;        // parked at the cursor inside this radius
    var RESUME_R = L * 0.6;       // ...and only restarts if the cursor moves past this one
    var SLOW_R = L * 3.2;         // start slowing down this far from the cursor

    var tg = targetPoint();
    var dx = tg.x - x, dy = tg.y - y, dist = Math.hypot(dx, dy);

    if (arrived) { if (dist > RESUME_R) arrived = false; }
    else if (dist < STOP_R) arrived = true;

    // Target speed: full cruise when far, linear slow-down on approach, zero when parked.
    var want = arrived ? 0 : VMAX * Math.max(0, Math.min(1, (dist - L * 0.2) / SLOW_R));
    var dv = want - speed, maxDv = ACC * dt;
    speed += Math.max(-maxDv, Math.min(maxDv, dv));
    if (speed < 0.5) speed = 0;

    // Steer toward the cursor; turning needs forward motion, so a parked robot stays still.
    if (!arrived && speed > 0) {
      var turn = wrap(Math.atan2(dy, dx) - psi);
      var maxTurn = 3.2 * dt * Math.max(0.35, Math.min(1, speed / (VMAX * 0.5)));
      psi += Math.max(-maxTurn, Math.min(maxTurn, turn));
    }
    var move = speed * dt;
    if (move > 0) {
      x += Math.cos(psi) * move;
      y += Math.sin(psi) * move;
    }

    // Wave and gait run in step with the head: at cruise they play at full rate,
    // slower as it slows, and freeze completely when it stops.
    t += dt * (speed / VMAX);

    // Record the path in fixed arclength steps so the body can follow it.
    var lastPt = trail[trail.length - 1];
    var gap = Math.hypot(x - lastPt.x, y - lastPt.y);
    if (gap >= DS) {
      var n = Math.floor(gap / DS), ux = (x - lastPt.x) / gap, uy = (y - lastPt.y) / gap;
      for (var i = 1; i <= n; i++) trail.push({ x: lastPt.x + ux * DS * i, y: lastPt.y + uy * DS * i });
      if (trail.length > 360) trail.splice(0, trail.length - 360);
    }
  }

  /* Gait: foot fore-aft offset (in L) and whether it is planted */
  function gait(k, side) {
    var p = frac(t / PERIOD - k * LEG_LAG + (side > 0 ? 0 : 0.5));
    var f;
    if (p < DUTY) f = 1 - 2 * (p / DUTY);                 // stance: foot slides back
    else f = -1 + 2 * ((p - DUTY) / (1 - DUTY));          // swing: foot returns forward
    return { f: f, stance: p < DUTY };
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Path trace (what the body is following), fading toward the tail
    var n = trail.length;
    if (n > 2) {
      for (var i = Math.max(1, n - 300); i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.strokeStyle = 'rgba(31,79,255,' + (0.3 * (i - (n - 300)) / 300).toFixed(3) + ')';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    var segs = pose(), contacts = 0;

    // Legs: stub out from the body, then a short hook along the body to the foot
    for (var k = 0; k < segs.length; k++) {
      var s = segs[k], ux = Math.cos(s.a), uy = Math.sin(s.a);
      for (var side = -1; side <= 1; side += 2) {
        var nx = -uy * side, ny = ux * side;
        var g = gait(k, side);
        if (g.stance) contacts++;
        var tipx = s.x + nx * L * 0.55, tipy = s.y + ny * L * 0.55;
        var fx = tipx + ux * g.f * L * 0.26, fy = tipy + uy * g.f * L * 0.26;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(tipx, tipy);
        ctx.lineTo(fx, fy);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(fx, fy, Math.max(3.2, L * 0.07), 0, TAU);
        ctx.fillStyle = g.stance ? ACCENT : '#fff';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = INK;
        ctx.stroke();
      }
    }

    // Body: thick line per segment, small circles at the joints
    for (var j = 0; j < segs.length; j++) {
      var q = segs[j], cx = Math.cos(q.a) * L / 2, cy = Math.sin(q.a) * L / 2;
      ctx.beginPath();
      ctx.moveTo(q.x + cx, q.y + cy);
      ctx.lineTo(q.x - cx, q.y - cy);
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(3.5, L * 0.08);
      ctx.stroke();
    }
    for (var m = 1; m < segs.length; m++) {
      var p = segs[m], jx = p.x + Math.cos(p.a) * L / 2, jy = p.y + Math.sin(p.a) * L / 2;
      ctx.beginPath();
      ctx.arc(jx, jy, Math.max(2.6, L * 0.05), 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    // Head marker
    var hd = segs[0];
    ctx.beginPath();
    ctx.arc(hd.x + Math.cos(hd.a) * L / 2, hd.y + Math.sin(hd.a) * L / 2, Math.max(4, L * 0.1), 0, TAU);
    ctx.fillStyle = ACCENT;
    ctx.fill();

    if (readout) readout.textContent = 't = ' + t.toFixed(1) + ' s  ·  contacting legs = ' + contacts;
  }

  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduceMotion || !inView || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  window.addEventListener('pointermove', function (e) {
    var r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  }, { passive: true });
  window.addEventListener('resize', resize);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      inView ? start() : stop();
    }, { threshold: 0.05 }).observe(canvas);
  }

  resize();
  if (reduceMotion) { t = 0; draw(); } else { start(); }
})();
