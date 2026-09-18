// 前台轻量脚本：文章阅读量上报、友链申请与评论异步提交
(function () {
  'use strict';

  // ---- 文章阅读量：只在文章详情页累加 ----
  // slug 由服务端渲染进 <body data-slug="…">；独立页面（/p/<别名>）不带 slug，
  // 所以页面不会被计进阅读数。异步上报、不等结果，失败也不影响阅读。
  // 说明：整站 PV/UV 上报（/api/hit）已随存储改造移除 —— 那是「每次访问 +1」的
  // 高频写，Blob 没有原子自增，并发下必然丢计数；文章阅读数写入频率低得多。
  var slug = document.body && document.body.dataset.slug;
  if (slug) {
    fetch('/api/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: slug }),
    }).catch(function () {});
  }

  // ---- 友链申请表单（/links 页）----
  var lkForm = document.getElementById('lk-form');
  if (lkForm) {
    var lkBtn = document.getElementById('lk-submit');
    var lkMsg = document.getElementById('lk-msg');
    var lkCap = document.getElementById('lk-capimg');
    function lkRefreshCap() {
      if (lkCap) lkCap.src = '/api/captcha?t=' + Date.now();
    }
    // kind: ok=绿 bad=红 空=中性灰
    function lkSay(text, kind) {
      lkMsg.textContent = text;
      lkMsg.className = 'lf-msg' + (kind ? ' ' + kind : '');
    }
    if (lkCap) lkCap.addEventListener('click', lkRefreshCap);
    lkForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = (lkForm.name.value || '').trim();
      var url = (lkForm.url.value || '').trim();
      if (!name) { lkSay('请填写站点名称', 'bad'); return; }
      if (!url) { lkSay('请填写站点地址', 'bad'); return; }
      // 服务端还会再校验一次，这里只是提前给提示，避免白跑一趟
      if (!/^https?:\/\/\S+$/i.test(url)) { lkSay('网址需以 http:// 或 https:// 开头', 'bad'); return; }
      var captcha = lkForm.captcha ? (lkForm.captcha.value || '').trim() : '';
      if (lkForm.captcha && !captcha) { lkSay('请填写图片算式的答案', 'bad'); return; }
      lkBtn.disabled = true;
      lkSay('提交中…', '');
      fetch('/api/link-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name, url: url,
          description: (lkForm.description.value || '').trim(),
          logo: (lkForm.logo.value || '').trim(),
          contact: (lkForm.contact.value || '').trim(),
          reason: (lkForm.reason.value || '').trim(),
          captcha: captcha,
          company: (lkForm.company && lkForm.company.value) || '',
        }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
        .then(function (x) {
          lkBtn.disabled = false;
          lkRefreshCap();
          if (!x.r.ok) { lkSay(x.d.error || '提交失败，请稍后再试', 'bad'); lkRefreshCap(); return; }
          lkForm.reset();
          lkSay('提交成功，等待站长审核，通过后会出现在上方列表。', 'ok');
        })
        .catch(function () { lkBtn.disabled = false; lkSay('网络错误，请稍后再试', 'bad'); });
    });
    return;
  }

  var form = document.getElementById('cform');
  if (!form) return;
  // 验证码：点击图片换一张（加时间戳防缓存）
  var capImg = document.getElementById('capimg');
  function refreshCap() {
    if (capImg) capImg.src = '/api/captcha?t=' + Date.now();
  }
  if (capImg) {
    capImg.addEventListener('click', refreshCap);
    capImg.addEventListener('error', function () { capImg.title = '加载失败，点击重试'; });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var okEl = document.getElementById('cmsg-ok');
    var badEl = document.getElementById('cmsg-bad');
    function showBad(msg) {
      badEl.textContent = msg;
      badEl.style.display = 'block';
      if (okEl) okEl.style.display = 'none';
    }
    badEl.style.display = 'none';
    if (okEl) okEl.style.display = 'none';
    btn.disabled = true;
    var body = { slug: form.dataset.post };
    body.author = (form.author.value || '').trim();
    body.email = (form.email.value || '').trim();
    body.website = (form.website && form.website.value || '').trim();
    body.content = (form.content.value || '').trim();
    // 算术验证码：题面在图片里，答案存在 HttpOnly Cookie（前端读不到，只负责回传输入值）
    body.captcha = (form.captcha && form.captcha.value || '').trim();
    body.company = (form.company && form.company.value) || '';
    if (!body.author) { btn.disabled = false; return showBad('请填写昵称'); }
    // 邮箱必填：用于生成 Gravatar 头像（只取 MD5，不公开原文）
    if (!body.email) { btn.disabled = false; return showBad('请填写邮箱，用于显示头像（不会公开）'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) { btn.disabled = false; return showBad('邮箱格式不正确'); }
    if (body.content.length < 3) { btn.disabled = false; return showBad('内容至少 3 个字'); }
    if (form.captcha && !body.captcha) { btn.disabled = false; return showBad('请填写图片算式的答案'); }
    fetch('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        btn.disabled = false;
        // 验证码一次性：成功（服务端已作废旧 Cookie）或答错都换一道新题
        refreshCap();
        if (!x.r.ok) return showBad(x.d.error || '提交失败，请稍后再试');
        form.reset();
        if (okEl) {
          okEl.style.display = 'block';
          okEl.textContent = x.d.pending ? '提交成功，审核通过后将在这里显示。' : '提交成功，感谢评论！';
        }
        if (!x.d.pending) setTimeout(function () { location.reload(); }, 1200);
      })
      .catch(function () { btn.disabled = false; showBad('网络错误，请稍后再试'); });
  });
})();