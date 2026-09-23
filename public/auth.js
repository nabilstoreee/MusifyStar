var Auth = {
    currentUser: null,
    token: null,
    mode: 'login', // 'login' | 'register'
    isPasswordVisible: false,
    activeBannedUser: null,

    init() {
        var savedToken = localStorage.getItem('musifystar_auth_token') || sessionStorage.getItem('musifystar_auth_token');
        var savedUser = localStorage.getItem('musifystar_auth_user') || sessionStorage.getItem('musifystar_auth_user');

        if (savedToken) {
            Auth.token = savedToken;
            if (savedUser) {
                try { Auth.currentUser = JSON.parse(savedUser); } catch(e) {}
            }
        }

        // Check persistent local ban first
        try {
            var savedBanRaw = localStorage.getItem('musifystar_active_ban');
            if (savedBanRaw) {
                var savedBan = JSON.parse(savedBanRaw);
                if (savedBan && savedBan.ban) {
                    var isExpired = false;
                    if (savedBan.ban.banType === 'temporary' && savedBan.ban.banExpiresAt) {
                        if (new Date(savedBan.ban.banExpiresAt).getTime() <= Date.now()) {
                            isExpired = true;
                        }
                    }
                    if (!isExpired) {
                        Auth.activeBannedUser = savedBan.user || null;
                        setTimeout(function() {
                            Auth.showBanModal(savedBan.ban);
                        }, 80);
                    } else {
                        localStorage.removeItem('musifystar_active_ban');
                    }
                }
            }
        } catch(e) {}

        Auth.checkSession();
        Auth.startRealtimeBanMonitor();

        // Check ban immediately when switching back to browser tab
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) {
                Auth.checkSession();
            }
        });
    },

    startRealtimeBanMonitor() {
        if (window._realtimeBanMonitorTimer) clearInterval(window._realtimeBanMonitorTimer);
        // Poll every 5 seconds in real-time to check if admin banned account or IP
        window._realtimeBanMonitorTimer = setInterval(function() {
            Auth.checkSession();
        }, 5000);
    },

    async checkSession() {
        try {
            var headers = {};
            if (Auth.token) {
                headers['Authorization'] = 'Bearer ' + Auth.token;
            }
            var res = await fetch('/api/user-auth?action=me', {
                headers: headers,
                cache: 'no-store'
            });
            var data = await res.json();

            // First check if IP or Account is Banned or Warned
            if (data && (data.ipBanned || data.banned || (data.ban && (data.ban.isBanned || data.ban.isIpBanned || data.ban.isWarning)))) {
                // Pause audio playback if playing
                if (window.MusicPlayer) {
                    try {
                        if (typeof MusicPlayer.pause === 'function') MusicPlayer.pause();
                        if (MusicPlayer.sound && typeof MusicPlayer.sound.pause === 'function') MusicPlayer.sound.pause();
                    } catch(e){}
                }

                if (data.user) {
                    Auth.activeBannedUser = {
                        username: data.user.username,
                        userId: data.user.id,
                        email: data.user.rawEmail || data.user.email
                    };
                } else if (Auth.currentUser) {
                    Auth.activeBannedUser = {
                        username: Auth.currentUser.username,
                        userId: Auth.currentUser.id,
                        email: Auth.currentUser.rawEmail || Auth.currentUser.email
                    };
                }

                // Simpan cache ban aktif secara konsisten
                try {
                    localStorage.setItem('musifystar_active_ban', JSON.stringify({
                        ban: data.ban || { isBanned: true, banReason: data.message },
                        user: Auth.activeBannedUser,
                        timestamp: Date.now()
                    }));
                } catch(e) {}

                Auth.showBanModal(data.ban || { isBanned: true, isIpBanned: !!data.ipBanned, banReason: data.message });
                return;
            }

            // Remove existing ban modal ONLY when confirmed safe & unbanned by server
            var existingModal = gid('user-banned-banner-modal');
            if (existingModal) {
                var modalCategory = existingModal.dataset.banCategory;
                if (modalCategory === 'ip' && data && !data.ipBanned && (!data.ban || !data.ban.isIpBanned)) {
                    existingModal.remove();
                    localStorage.removeItem('musifystar_active_ban');
                } else if (modalCategory === 'account' && data && !data.banned && (!data.ban || !data.ban.isBanned)) {
                    existingModal.remove();
                    localStorage.removeItem('musifystar_active_ban');
                }
            }

            if (data && data.authenticated && data.user) {
                Auth.currentUser = data.user;
                if (data.newToken) {
                    Auth.token = data.newToken;
                    if (localStorage.getItem('musifystar_auth_token')) {
                        localStorage.setItem('musifystar_auth_token', data.newToken);
                    } else {
                        sessionStorage.setItem('musifystar_auth_token', data.newToken);
                    }
                }
                if (localStorage.getItem('musifystar_auth_token')) {
                    localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                } else {
                    sessionStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                }
                Auth.updateHeaderUI();
            }
        } catch (e) {
            console.warn('Check session error:', e);
        }
    },

    updateHeaderUI() {
        var profileBtns = document.querySelectorAll('.header-profile-btn');
        profileBtns.forEach(function(btn) {
            if (Auth.currentUser) {
                btn.innerHTML = '<img src="' + (Auth.currentUser.avatar || '/logo.png') + '" class="w-full h-full rounded-full object-cover" alt="Avatar" onerror="this.src=\'/logo.png\'">';
                btn.setAttribute('title', 'Akun: ' + Auth.currentUser.username);
            } else {
                btn.innerHTML = '<i data-lucide="user" class="w-5 h-5"></i>';
                btn.setAttribute('title', 'Login / Profil');
            }
        });
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            try { window.lucide.createIcons(); } catch(e){}
        }
    },

    toggleTopDropdown(triggerEl) {
        var existing = gid('header-auth-dropdown-wrapper');
        if (existing) {
            existing.remove();
            return;
        }

        var wrapper = document.createElement('div');
        wrapper.id = 'header-auth-dropdown-wrapper';
        wrapper.className = 'fixed inset-0 z-50 flex justify-end items-start pt-16 pr-4 sm:pr-8 animate-fadeIn pointer-events-auto';
        wrapper.innerHTML = `
            <div onclick="gid('header-auth-dropdown-wrapper')?.remove()" class="fixed inset-0 bg-black/40 backdrop-blur-[2px]"></div>
            <div class="relative z-10 w-[92vw] max-w-[340px] bg-[#12141c]/95 backdrop-blur-2xl border border-white/20 rounded-3xl p-5 shadow-2xl shadow-black/80 text-left transition-all duration-300 transform scale-100 origin-top-right">
                <button onclick="gid('header-auth-dropdown-wrapper')?.remove()" class="absolute top-3.5 right-3.5 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95 cursor-pointer">
                    <i data-lucide="x" class="w-4 h-4"></i>
                </button>
                <div id="header-auth-content">
                    ${Auth.currentUser ? Auth.getLoggedInDropdownHTML() : Auth.getFormHTML('header-')}
                </div>
            </div>
        `;

        document.body.appendChild(wrapper);
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            try { window.lucide.createIcons(); } catch(e){}
        }
    },

    setMode(mode, prefix) {
        Auth.mode = mode;
        Auth.isPasswordVisible = false;
        var p = prefix || 'header-';
        var container = gid('header-auth-content');
        if (container) {
            container.innerHTML = Auth.getFormHTML(p);
            if (window.lucide && typeof window.lucide.createIcons === 'function') {
                try { window.lucide.createIcons(); } catch(e){}
            }
        }
    },

    togglePassword(inputFieldId, iconId) {
        var input = gid(inputFieldId);
        var icon = gid(iconId);
        if (!input) return;
        if (input.type === 'password') {
            input.type = 'text';
            if (icon) icon.setAttribute('data-lucide', 'eye-off');
        } else {
            input.type = 'password';
            if (icon) icon.setAttribute('data-lucide', 'eye');
        }
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            try { window.lucide.createIcons(); } catch(e){}
        }
    },

    getFormHTML(prefix) {
        prefix = prefix || 'header-';
        if (Auth.mode === 'login') {
            return `
            <div>
                <div class="flex items-center gap-2.5 mb-4 pr-6">
                    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-sky-500/20">
                        <i data-lucide="log-in" class="w-4 h-4"></i>
                    </div>
                    <div>
                        <h3 class="text-white font-bold text-base tracking-tight leading-tight">Login Akun</h3>
                        <p class="text-white/50 text-[10px]">Masuk ke akun MusifyStar Anda</p>
                    </div>
                </div>

                <form onsubmit="Auth.handleLogin(event, '${prefix}')" class="space-y-3">
                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center gap-1.5">
                            <i data-lucide="user" class="w-3.5 h-3.5 text-sky-400"></i> Username
                        </label>
                        <input type="text" id="${prefix}auth-login-username" required placeholder="Masukkan username" class="w-full bg-black/50 border border-white/15 focus:border-sky-400 focus:ring-1 focus:ring-sky-400 rounded-xl px-3 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center gap-1.5">
                            <i data-lucide="mail" class="w-3.5 h-3.5 text-emerald-400"></i> Email
                        </label>
                        <input type="email" id="${prefix}auth-login-email" required placeholder="contoh@email.com" class="w-full bg-black/50 border border-white/15 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 rounded-xl px-3 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center justify-between">
                            <span class="flex items-center gap-1.5">
                                <i data-lucide="lock" class="w-3.5 h-3.5 text-amber-400"></i> Password (min 6 huruf)
                            </span>
                        </label>
                        <div class="relative flex items-center">
                            <input type="password" id="${prefix}auth-login-password" minlength="6" required placeholder="Minimal 6 karakter" class="w-full bg-black/50 border border-white/15 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 rounded-xl pl-3 pr-9 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                            <button type="button" onclick="Auth.togglePassword('${prefix}auth-login-password', '${prefix}auth-login-eye-icon')" class="absolute right-2 p-1 text-white/60 hover:text-white active:scale-95 transition-all cursor-pointer" title="Lihat / Sembunyikan Password">
                                <i id="${prefix}auth-login-eye-icon" data-lucide="eye" class="w-3.5 h-3.5"></i>
                            </button>
                        </div>
                    </div>

                    <div class="flex items-center justify-between pt-0.5">
                        <label class="flex items-center gap-2 cursor-pointer select-none group">
                            <input type="checkbox" id="${prefix}auth-login-remember" checked class="w-3.5 h-3.5 rounded bg-black/50 border-white/20 text-sky-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-sky-500">
                            <span class="text-[11px] text-white/80 group-hover:text-white transition-colors">Simpan login</span>
                        </label>
                    </div>

                    <button type="submit" id="${prefix}auth-login-btn" class="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-sky-500 via-indigo-500 to-purple-500 hover:opacity-95 active:scale-98 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-sky-500/25 cursor-pointer mt-1">
                        <i data-lucide="log-in" class="w-3.5 h-3.5"></i>
                        <span>Login</span>
                    </button>

                    <div class="text-center pt-2 border-t border-white/10">
                        <p class="text-[11px] text-white/60">
                            Belum punya akun? 
                            <button type="button" onclick="Auth.setMode('register', '${prefix}')" class="text-sky-400 hover:text-sky-300 font-bold underline cursor-pointer ml-1 active:scale-95 transition-all">
                                daftar disini
                            </button>
                        </p>
                    </div>
                </form>
            </div>
            `;
        } else {
            return `
            <div>
                <div class="flex items-center gap-2.5 mb-4 pr-6">
                    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-500 flex items-center justify-center text-white shadow-md shadow-emerald-500/20">
                        <i data-lucide="user-plus" class="w-4 h-4"></i>
                    </div>
                    <div>
                        <h3 class="text-white font-bold text-base tracking-tight leading-tight">Daftar Akun</h3>
                        <p class="text-white/50 text-[10px]">Buat akun baru MusifyStar</p>
                    </div>
                </div>

                <form onsubmit="Auth.handleRegister(event, '${prefix}')" class="space-y-3">
                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center gap-1.5">
                            <i data-lucide="user" class="w-3.5 h-3.5 text-emerald-400"></i> Username
                        </label>
                        <input type="text" id="${prefix}auth-reg-username" required placeholder="Pilih username baru" class="w-full bg-black/50 border border-white/15 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 rounded-xl px-3 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center gap-1.5">
                            <i data-lucide="mail" class="w-3.5 h-3.5 text-sky-400"></i> Email
                        </label>
                        <input type="email" id="${prefix}auth-reg-email" required placeholder="contoh@email.com" class="w-full bg-black/50 border border-white/15 focus:border-sky-400 focus:ring-1 focus:ring-sky-400 rounded-xl px-3 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-white/80 mb-1 flex items-center justify-between">
                            <span class="flex items-center gap-1.5">
                                <i data-lucide="lock" class="w-3.5 h-3.5 text-amber-400"></i> Password (min 6 huruf)
                            </span>
                        </label>
                        <div class="relative flex items-center">
                            <input type="password" id="${prefix}auth-reg-password" minlength="6" required placeholder="Minimal 6 karakter" class="w-full bg-black/50 border border-white/15 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 rounded-xl pl-3 pr-9 py-2 text-xs text-white placeholder-white/30 outline-none transition-all">
                            <button type="button" onclick="Auth.togglePassword('${prefix}auth-reg-password', '${prefix}auth-reg-eye-icon')" class="absolute right-2 p-1 text-white/60 hover:text-white active:scale-95 transition-all cursor-pointer" title="Lihat / Sembunyikan Password">
                                <i id="${prefix}auth-reg-eye-icon" data-lucide="eye" class="w-3.5 h-3.5"></i>
                            </button>
                        </div>
                    </div>

                    <button type="submit" id="${prefix}auth-reg-btn" class="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500 hover:opacity-95 active:scale-98 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-emerald-500/25 cursor-pointer mt-1">
                        <i data-lucide="user-check" class="w-3.5 h-3.5"></i>
                        <span>Daftar Akun</span>
                    </button>

                    <div class="text-center pt-2 border-t border-white/10">
                        <p class="text-[11px] text-white/60">
                            Udah punya akun? 
                            <button type="button" onclick="Auth.setMode('login', '${prefix}')" class="text-emerald-400 hover:text-emerald-300 font-bold underline cursor-pointer ml-1 active:scale-95 transition-all">
                                login disini
                            </button>
                        </p>
                    </div>
                </form>
            </div>
            `;
        }
    },

    getBadgeSettings() {
        var saved = localStorage.getItem('musify_badge_settings');
        if (saved) {
            try {
                var parsed = JSON.parse(saved);
                if (parsed && typeof parsed.offsetY === 'number') {
                    if (!localStorage.getItem('musify_badge_offset_fixed_v4')) {
                        parsed.offsetY = -3;
                        localStorage.setItem('musify_badge_offset_fixed_v4', 'true');
                        localStorage.setItem('musify_badge_settings', JSON.stringify(parsed));
                    }
                }
                return parsed;
            } catch(e){}
        }
        return { margin: 2, size: 15, offsetY: -3, color: '#0095F6' };
    },

    saveBadgeSettings(s) {
        localStorage.setItem('musify_badge_settings', JSON.stringify(s));
    },

    getVerifiedBadgeHTML(customSettings) {
        var s = customSettings || Auth.getBadgeSettings();
        var margin = typeof s.margin === 'number' ? s.margin : 2;
        var size = typeof s.size === 'number' ? s.size : 15;
        var offsetY = typeof s.offsetY === 'number' ? s.offsetY : -3;
        var color = s.color || '#0095F6';
        var checkColor = (color.toLowerCase() === '#ffffff') ? '#000000' : '#FFFFFF';

        return `
        <span class="inline-flex items-center shrink-0 self-center" style="margin-left: ${margin}px; transform: translateY(${offsetY}px);" title="Akun Terverifikasi">
            <svg style="width: ${size}px; height: ${size}px;" class="shrink-0 inline-block align-middle" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="${color}" ${color.toLowerCase() === '#ffffff' ? 'stroke="#d4d4d8" stroke-width="1"' : ''}/>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M16.707 8.293a1 1 0 0 1 0 1.414l-6 6a1 1 0 0 1-1.414 0l-3-3a1 1 0 1 1 1.414-1.414L10 13.586l5.293-5.293a1 1 0 0 1 1.414 0z" fill="${checkColor}"/>
            </svg>
        </span>`;
    },

    toggleBadgeSettingsPanel() {
        var content = gid('badge-settings-content');
        var chevron = gid('badge-panel-chevron');
        if (!content) return;
        if (content.classList.contains('hidden')) {
            content.classList.remove('hidden');
            if (chevron) chevron.style.transform = 'rotate(180deg)';
        } else {
            content.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
        }
    },

    updateBadgeControl(field, value) {
        var s = Auth.getBadgeSettings();
        if (field === 'margin' || field === 'size' || field === 'offsetY') {
            s[field] = parseInt(value, 10);
        } else if (field === 'color') {
            s[field] = value;
        }
        Auth.saveBadgeSettings(s);

        var modalBadgeWrapper = gid('modal-badge-wrapper');
        if (modalBadgeWrapper) {
            modalBadgeWrapper.innerHTML = Auth.getVerifiedBadgeHTML(s);
        }
        var dropdownBadgeWrapper = gid('dropdown-badge-wrapper');
        if (dropdownBadgeWrapper) {
            dropdownBadgeWrapper.innerHTML = Auth.getVerifiedBadgeHTML(s);
        }
        document.querySelectorAll('.global-verified-badge-container').forEach(function(el) {
            el.innerHTML = Auth.getVerifiedBadgeHTML(s);
        });

        var lblMargin = gid('lbl-badge-margin');
        if (lblMargin) lblMargin.innerText = s.margin + 'px';
        var lblSize = gid('lbl-badge-size');
        if (lblSize) lblSize.innerText = s.size + 'px';
        var lblOffsetY = gid('lbl-badge-offsetY');
        if (lblOffsetY) lblOffsetY.innerText = (s.offsetY > 0 ? '+' : '') + s.offsetY + 'px';
    },

    resetBadgeSettings() {
        var defaultSettings = { margin: 2, size: 15, offsetY: -3, color: '#0095F6' };
        Auth.saveBadgeSettings(defaultSettings);

        var inpMargin = gid('inp-badge-margin');
        if (inpMargin) inpMargin.value = 2;
        var inpSize = gid('inp-badge-size');
        if (inpSize) inpSize.value = 15;
        var inpOffsetY = gid('inp-badge-offsetY');
        if (inpOffsetY) inpOffsetY.value = -3;

        Auth.updateBadgeControl('color', '#0095F6');
    },

    getLoggedInDropdownHTML() {
        var u = Auth.currentUser;
        if (!u) return '';
        var joinDate = u.createdAt ? new Date(u.createdAt).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Baru saja';
        var isVerified = ((u.email || '').toLowerCase().trim() === 'jrnabil570@gmail.com');
        return `
        <div>
            <div class="flex items-center gap-3 pb-3 border-b border-white/10 pr-6">
                <div class="relative w-11 h-11 rounded-full overflow-hidden shrink-0">
                    <img src="${u.avatar || '/logo.png'}" class="w-full h-full object-cover rounded-full" alt="Avatar" onerror="this.src='/logo.png'" />
                </div>
                <div>
                    <div class="flex items-center">
                        <h3 class="text-white font-bold text-sm leading-tight">${es(u.username)}</h3>${isVerified ? `
                        <span id="dropdown-badge-wrapper" class="global-verified-badge-container">${Auth.getVerifiedBadgeHTML()}</span>` : ''}
                    </div>
                    <p class="text-white/60 text-[11px] truncate max-w-[170px]">${es(u.email)}</p>
                </div>
            </div>

            <div class="py-2.5 space-y-1 text-[11px]">
                <div class="flex justify-between items-center text-white/70">
                    <span>Status</span>
                    <span class="text-emerald-400 font-semibold flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Member Aktif
                    </span>
                </div>
                <div class="flex justify-between items-center text-white/70">
                    <span>Bergabung</span>
                    <span class="text-white/90">${joinDate}</span>
                </div>
            </div>

            <div class="pt-2.5 border-t border-white/10 space-y-2">
                <button onclick="gid('header-auth-dropdown-wrapper')?.remove(); Auth.openUserProfileModal();" class="w-full py-2 px-3 rounded-xl bg-gradient-to-r from-sky-500/20 to-indigo-500/20 hover:from-sky-500/30 hover:to-indigo-500/30 border border-sky-500/30 text-white font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer shadow-sm">
                    <i data-lucide="user-pen" class="w-3.5 h-3.5 text-sky-400"></i>
                    <span>Buka Halaman Profil (Edit Profil)</span>
                </button>
                <button onclick="Auth.logout()" class="w-full py-2 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer">
                    <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
                    <span>Keluar Akun</span>
                </button>
            </div>
        </div>
        `;
    },

    openUserProfileModal() {
        var u = Auth.currentUser;
        if (!u) {
            Auth.toggleTopDropdown();
            return;
        }

        var existing = gid('user-profile-modal');
        if (existing) existing.remove();

        var avatarUrl = u.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(u.username)}`;
        var joinDate = u.createdAt ? new Date(u.createdAt).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }) : '23 Sep 2026';
        var isVerified = ((u.email || '').toLowerCase().trim() === 'jrnabil570@gmail.com');
        var badgeS = Auth.getBadgeSettings();

        var modal = document.createElement('div');
        modal.id = 'user-profile-modal';
        modal.className = 'fixed inset-0 z-[650] flex items-center justify-center p-4 animate-fadeIn';
        modal.innerHTML = `
            <div onclick="gid('user-profile-modal')?.remove()" class="fixed inset-0 bg-black/80 backdrop-blur-md"></div>
            <div class="relative z-10 w-full max-w-sm bg-[#12141c]/95 border border-white/20 rounded-3xl p-5 sm:p-6 shadow-2xl shadow-black text-left space-y-4 max-h-[90vh] overflow-y-auto custom-scrollbar">
                <input type="file" id="auth-gallery-file-input" accept="image/png, image/jpeg, image/webp, image/gif" style="display:none;" onchange="Auth.uploadAvatarFromGallery(event)">

                <div class="flex items-center justify-between pb-3 border-b border-white/10">
                    <div class="flex items-center gap-2">
                        <div class="w-8 h-8 rounded-xl bg-sky-500/20 border border-sky-500/30 text-sky-400 flex items-center justify-center">
                            <i data-lucide="user" class="w-4 h-4"></i>
                        </div>
                        <div>
                            <h3 class="text-white font-black text-base leading-tight">Halaman Profil</h3>
                            <p class="text-white/50 text-[10px]">Kelola akun & data profil Anda</p>
                        </div>
                    </div>
                    <button onclick="gid('user-profile-modal')?.remove()" class="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 text-white/70 hover:text-white flex items-center justify-center active:scale-95 cursor-pointer">
                        <i data-lucide="x" class="w-4 h-4"></i>
                    </button>
                </div>

                <div class="flex items-center gap-3.5 p-3 rounded-2xl bg-white/5 border border-white/10">
                    <div class="relative cursor-pointer shrink-0" onclick="Auth.triggerGalleryUpload()" title="Klik untuk ubah foto profil dari galeri">
                        <div class="w-16 h-16 rounded-full overflow-hidden shrink-0">
                            <img id="modal-user-avatar-img" src="${avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Foto Profil" onerror="this.src='/logo.png'">
                        </div>
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-white font-bold text-sm truncate mb-0.5 flex items-center">
                            <span>${es(u.username)}</span>${isVerified ? `
                            <span id="modal-badge-wrapper" class="global-verified-badge-container">${Auth.getVerifiedBadgeHTML(badgeS)}</span>` : ''}
                        </p>
                        <p class="text-white/60 text-xs truncate mb-2">${es(u.email)}</p>
                        <button onclick="Auth.triggerGalleryUpload()" class="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-300 hover:text-white bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 px-2.5 py-1 rounded-lg cursor-pointer active:scale-95 transition-all">
                            <i data-lucide="image" class="w-3 h-3"></i>
                            <span>Pilih dari Galeri</span>
                        </button>
                    </div>
                </div>

                ${isVerified ? `
                <div>
                    <button type="button" onclick="Auth.toggleBadgeSettingsPanel()" class="w-full flex items-center justify-between p-3 rounded-2xl bg-gradient-to-r from-sky-500/10 via-indigo-500/10 to-transparent hover:from-sky-500/20 hover:to-indigo-500/20 border border-sky-500/30 text-white transition-all cursor-pointer">
                        <div class="flex items-center gap-2">
                            <i data-lucide="sliders" class="w-4 h-4 text-sky-400"></i>
                            <span class="text-xs font-bold text-white">Atur Lencana Centang Biru</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] text-sky-300 font-medium">Buka / Tutup</span>
                            <i id="badge-panel-chevron" data-lucide="chevron-down" class="w-4 h-4 text-sky-400 transition-transform duration-200"></i>
                        </div>
                    </button>

                    <div id="badge-settings-content" class="hidden p-3.5 mt-2 rounded-2xl bg-black/40 border border-sky-500/30 space-y-3">
                        <div class="flex items-center justify-between pb-2 border-b border-white/10">
                            <span class="text-[11px] text-white/60">Kustomisasi Posisi & Warna</span>
                            <button type="button" onclick="Auth.resetBadgeSettings()" class="text-[10px] text-sky-400 hover:text-sky-300 font-semibold underline cursor-pointer">
                                Reset Default
                            </button>
                        </div>

                        <div class="space-y-2.5 text-xs text-white/80">
                            <div>
                                <div class="flex justify-between items-center mb-1 text-[11px]">
                                    <span class="text-white/70">Jarak Ke Samping (Kiri/Kanan):</span>
                                    <span id="lbl-badge-margin" class="font-mono text-sky-400 font-bold">${badgeS.margin}px</span>
                                </div>
                                <input type="range" id="inp-badge-margin" min="-4" max="24" value="${badgeS.margin}" step="1"
                                    oninput="Auth.updateBadgeControl('margin', this.value)"
                                    class="w-full accent-sky-400 cursor-pointer h-1.5 bg-black/50 rounded-lg">
                            </div>

                            <div>
                                <div class="flex justify-between items-center mb-1 text-[11px]">
                                    <span class="text-white/70">Ukuran Lencana:</span>
                                    <span id="lbl-badge-size" class="font-mono text-sky-400 font-bold">${badgeS.size}px</span>
                                </div>
                                <input type="range" id="inp-badge-size" min="10" max="28" value="${badgeS.size}" step="1"
                                    oninput="Auth.updateBadgeControl('size', this.value)"
                                    class="w-full accent-sky-400 cursor-pointer h-1.5 bg-black/50 rounded-lg">
                            </div>

                            <div>
                                <div class="flex justify-between items-center mb-1 text-[11px]">
                                    <span class="text-white/70">Posisi Vertikal (Atas/Bawah):</span>
                                    <span id="lbl-badge-offsetY" class="font-mono text-sky-400 font-bold">${badgeS.offsetY > 0 ? '+' : ''}${badgeS.offsetY}px</span>
                                </div>
                                <input type="range" id="inp-badge-offsetY" min="-6" max="6" value="${badgeS.offsetY}" step="1"
                                    oninput="Auth.updateBadgeControl('offsetY', this.value)"
                                    class="w-full accent-sky-400 cursor-pointer h-1.5 bg-black/50 rounded-lg">
                            </div>

                            <div>
                                <span class="text-[11px] text-white/70 block mb-1.5">Warna Lencana:</span>
                                <div class="flex items-center gap-2.5">
                                    <button type="button" onclick="Auth.updateBadgeControl('color', '#0095F6')" class="w-6 h-6 rounded-full bg-[#0095F6] border-2 border-white/40 hover:scale-110 transition cursor-pointer" title="Biru"></button>
                                    <button type="button" onclick="Auth.updateBadgeControl('color', '#10b981')" class="w-6 h-6 rounded-full bg-[#10b981] border-2 border-white/40 hover:scale-110 transition cursor-pointer" title="Hijau"></button>
                                    <button type="button" onclick="Auth.updateBadgeControl('color', '#18181b')" class="w-6 h-6 rounded-full bg-[#18181b] border-2 border-white/40 hover:scale-110 transition cursor-pointer" title="Hitam"></button>
                                    <button type="button" onclick="Auth.updateBadgeControl('color', '#ffffff')" class="w-6 h-6 rounded-full bg-[#ffffff] border-2 border-white/40 hover:scale-110 transition cursor-pointer" title="Putih"></button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>` : ''}

                <div class="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-semibold uppercase tracking-wider text-white/50 flex items-center gap-1">
                            <i data-lucide="user" class="w-3 h-3 text-sky-400"></i> Username
                        </span>
                        <button onclick="Auth.toggleEditField('username')" class="w-7 h-7 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 text-sky-300 flex items-center justify-center active:scale-95 transition cursor-pointer" title="Ubah Username (Logo Pulpen)">
                            <i data-lucide="pen-line" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                    <div id="display-field-username" class="flex items-center justify-between">
                        <p class="text-xs font-bold text-white truncate">${es(u.username)}</p>
                        <span class="text-[10px] text-white/40">Klik logo pulpen untuk ubah</span>
                    </div>
                    <form id="edit-form-username" onsubmit="Auth.saveEditedUsername(event)" class="hidden space-y-2 pt-1">
                        <input type="text" id="input-edit-username" required minlength="3" value="${es(u.username)}" class="w-full bg-black/60 border border-sky-500/50 rounded-xl px-3 py-1.5 text-xs text-white outline-none">
                        <div class="flex justify-end gap-1.5">
                            <button type="button" onclick="Auth.toggleEditField('username')" class="px-2.5 py-1 rounded-lg bg-white/10 text-white/70 text-[10px] font-semibold cursor-pointer">Batal</button>
                            <button type="submit" id="btn-save-username" class="px-3 py-1 rounded-lg bg-sky-500 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer">
                                <i data-lucide="check" class="w-3 h-3"></i> Simpan
                            </button>
                        </div>
                    </form>
                </div>

                <div class="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-semibold uppercase tracking-wider text-white/50 flex items-center gap-1">
                            <i data-lucide="mail" class="w-3 h-3 text-emerald-400"></i> Email
                        </span>
                        <button onclick="Auth.toggleEditField('email')" class="w-7 h-7 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-300 flex items-center justify-center active:scale-95 transition cursor-pointer" title="Ubah Email (Logo Pulpen)">
                            <i data-lucide="pen-line" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                    <div id="display-field-email" class="flex items-center justify-between">
                        <p class="text-xs font-bold text-white truncate">${es(u.email)}</p>
                        <span class="text-[10px] text-white/40">Klik logo pulpen untuk ubah</span>
                    </div>
                    <form id="edit-form-email" onsubmit="Auth.saveEditedEmail(event)" class="hidden space-y-2 pt-1">
                        <input type="email" id="input-edit-email" required value="${es(u.email)}" class="w-full bg-black/60 border border-emerald-500/50 rounded-xl px-3 py-1.5 text-xs text-white outline-none">
                        <div class="flex justify-end gap-1.5">
                            <button type="button" onclick="Auth.toggleEditField('email')" class="px-2.5 py-1 rounded-lg bg-white/10 text-white/70 text-[10px] font-semibold cursor-pointer">Batal</button>
                            <button type="submit" id="btn-save-email" class="px-3 py-1 rounded-lg bg-emerald-500 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer">
                                <i data-lucide="check" class="w-3 h-3"></i> Simpan
                            </button>
                        </div>
                    </form>
                </div>

                <div class="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-semibold uppercase tracking-wider text-white/50 flex items-center gap-1">
                            <i data-lucide="lock" class="w-3 h-3 text-amber-400"></i> Password
                        </span>
                        <button type="button" onclick="Auth.toggleEditField('password')" class="w-7 h-7 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 flex items-center justify-center active:scale-95 transition cursor-pointer" title="Ubah Password (Logo Pulpen)">
                            <i data-lucide="pen-line" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                    <div id="display-field-password" class="flex items-center justify-between">
                        <p class="text-xs font-bold text-white tracking-widest font-mono">••••••••</p>
                        <span class="text-[10px] text-white/40">Klik logo pulpen untuk ubah</span>
                    </div>
                    <form id="edit-form-password" onsubmit="Auth.saveEditedPassword(event)" class="hidden space-y-2.5 pt-1">
                        <div>
                            <label class="block text-[10px] font-semibold text-white/70 mb-1">Password Baru (min 6 huruf)</label>
                            <input type="password" id="modal-auth-pw-new" minlength="6" required placeholder="Masukkan password baru" class="w-full bg-black/60 border border-amber-500/50 rounded-xl px-3 py-1.5 text-xs text-white outline-none">
                        </div>
                        <div>
                            <label class="block text-[10px] font-semibold text-white/70 mb-1">Konfirmasi Password Baru</label>
                            <input type="password" id="modal-auth-pw-confirm" minlength="6" required placeholder="Ulangi password baru" class="w-full bg-black/60 border border-amber-500/50 rounded-xl px-3 py-1.5 text-xs text-white outline-none">
                        </div>
                        <div class="flex justify-end gap-1.5 pt-1">
                            <button type="button" onclick="Auth.toggleEditField('password')" class="px-2.5 py-1 rounded-lg bg-white/10 text-white/70 text-[10px] font-semibold cursor-pointer">Batal</button>
                            <button type="submit" id="btn-save-password" class="px-3 py-1 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer">
                                <i data-lucide="check" class="w-3 h-3"></i> Simpan Password
                            </button>
                        </div>
                    </form>
                </div>

                <div class="pt-2 border-t border-white/10 flex items-center justify-between">
                    <span class="text-[10px] text-white/50">Bergabung: ${joinDate}</span>
                    <button onclick="gid('user-profile-modal')?.remove(); Auth.logout();" class="text-xs px-3 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 font-semibold flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer">
                        <i data-lucide="log-out" class="w-3.5 h-3.5"></i> Keluar Akun
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        if (window.lucide) lucide.createIcons();
    },

    toggleEditField(fieldName) {
        var displayEl = gid('display-field-' + fieldName);
        var formEl = gid('edit-form-' + fieldName);
        if (!displayEl || !formEl) return;
        if (formEl.classList.contains('hidden')) {
            formEl.classList.remove('hidden');
            displayEl.classList.add('hidden');
            var input = formEl.querySelector('input');
            if (input) input.focus();
        } else {
            formEl.classList.add('hidden');
            displayEl.classList.remove('hidden');
        }
    },

    triggerGalleryUpload() {
        var input = gid('auth-gallery-file-input');
        if (input) {
            input.value = '';
            input.click();
        }
    },

    uploadAvatarFromGallery(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showToast('Hanya file gambar dari galeri yang didukung');
            return;
        }

        var reader = new FileReader();
        reader.onload = function(e) {
            var img = new Image();
            img.onload = function() {
                var canvas = document.createElement('canvas');
                var size = 300;
                canvas.width = size;
                canvas.height = size;
                var ctx = canvas.getContext('2d');

                var minDim = Math.min(img.width, img.height);
                var sx = (img.width - minDim) / 2;
                var sy = (img.height - minDim) / 2;
                ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

                var base64Data = canvas.toDataURL('image/jpeg', 0.85);
                Auth.saveAvatar(base64Data);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    },

    async saveAvatar(base64Data) {
        if (!Auth.token) {
            showToast('Silakan login terlebih dahulu');
            return;
        }
        showToast('Menyimpan foto profil dari galeri...');
        try {
            var res = await fetch('/api/user-auth?action=update_profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + Auth.token
                },
                body: JSON.stringify({ avatar: base64Data })
            });
            var data = await res.json();
            if (data && data.status && data.user) {
                Auth.currentUser = data.user;
                if (localStorage.getItem('musifystar_auth_token')) {
                    localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                } else {
                    sessionStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                }
                showToast('Foto profil berhasil diubah!');
                Auth.updateHeaderUI();
                Auth.openUserProfileModal();
            } else {
                showToast(data?.message || 'Gagal mengubah foto');
            }
        } catch(e) {
            showToast('Koneksi bermasalah saat upload');
        }
    },

    async saveEditedUsername(e) {
        if (e && e.preventDefault) e.preventDefault();
        var newUsername = (gid('input-edit-username')?.value || '').trim();
        if (!newUsername || newUsername.length < 3) {
            showToast('Username minimal 3 karakter');
            return;
        }

        var btn = gid('btn-save-username');
        if (btn) btn.disabled = true;

        try {
            var res = await fetch('/api/user-auth?action=update_profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + Auth.token
                },
                body: JSON.stringify({ username: newUsername })
            });
            var data = await res.json();
            if (data && data.status && data.user) {
                Auth.currentUser = data.user;
                if (localStorage.getItem('musifystar_auth_token')) {
                    localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                } else {
                    sessionStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                }
                showToast('Username berhasil diperbarui!');
                Auth.updateHeaderUI();
                Auth.openUserProfileModal();
            } else {
                showToast(data?.message || 'Gagal mengubah username');
            }
        } catch(err) {
            showToast('Koneksi bermasalah');
        }
    },

    async saveEditedEmail(e) {
        if (e && e.preventDefault) e.preventDefault();
        var newEmail = (gid('input-edit-email')?.value || '').trim();
        if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            showToast('Format email tidak valid');
            return;
        }

        var btn = gid('btn-save-email');
        if (btn) btn.disabled = true;

        try {
            var res = await fetch('/api/user-auth?action=update_profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + Auth.token
                },
                body: JSON.stringify({ email: newEmail })
            });
            var data = await res.json();
            if (data && data.status && data.user) {
                Auth.currentUser = data.user;
                if (localStorage.getItem('musifystar_auth_token')) {
                    localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                } else {
                    sessionStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                }
                showToast('Email berhasil diperbarui!');
                Auth.updateHeaderUI();
                Auth.openUserProfileModal();
            } else {
                showToast(data?.message || 'Gagal mengubah email');
            }
        } catch(err) {
            showToast('Koneksi bermasalah');
        }
    },

    async saveEditedPassword(e) {
        if (e && e.preventDefault) e.preventDefault();
        var newPw = (gid('modal-auth-pw-new')?.value || '').trim();
        var confirmPw = (gid('modal-auth-pw-confirm')?.value || '').trim();

        if (newPw.length < 6) {
            showToast('Password minimal 6 karakter');
            return;
        }
        if (newPw !== confirmPw) {
            showToast('Konfirmasi password tidak cocok');
            return;
        }

        var btn = gid('btn-save-password');
        if (btn) btn.disabled = true;

        try {
            var res = await fetch('/api/user-auth?action=update_password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + Auth.token
                },
                body: JSON.stringify({ newPassword: newPw })
            });
            var data = await res.json();
            if (data && data.status) {
                showToast('Password berhasil diubah!');
                Auth.toggleEditField('password');
            } else {
                showToast(data?.message || 'Gagal mengubah password');
            }
        } catch(err) {
            showToast('Koneksi bermasalah');
        }
    },

    async handleLogin(e, prefix) {
        if (e && e.preventDefault) e.preventDefault();
        prefix = prefix || 'header-';
        var username = (gid(prefix + 'auth-login-username')?.value || '').trim();
        var email = (gid(prefix + 'auth-login-email')?.value || '').trim();
        var password = (gid(prefix + 'auth-login-password')?.value || '').trim();
        var remember = gid(prefix + 'auth-login-remember')?.checked !== false;

        var btn = gid(prefix + 'auth-login-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Memproses...</span>';
            if (window.lucide && typeof window.lucide.createIcons === 'function') try{ window.lucide.createIcons(); }catch(err){}
        }

        try {
            var res = await fetch('/api/user-auth?action=login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, email: email, password: password, rememberMe: remember })
            });
            var data = {};
            try { data = await res.json(); } catch(e) {}

            if (data && (data.banned || (data.ban && data.ban.isBanned))) {
                var canonicalUsername = data.user?.username || username;
                var canonicalEmail = data.user?.rawEmail || data.user?.email || email;
                var canonicalUserId = data.user?.id || '';
                Auth.activeBannedUser = { username: canonicalUsername, email: canonicalEmail, userId: canonicalUserId };
                try {
                    localStorage.setItem('musifystar_active_ban', JSON.stringify({
                        ban: data.ban,
                        user: Auth.activeBannedUser,
                        timestamp: Date.now()
                    }));
                } catch(e) {}
                gid('header-auth-dropdown-wrapper')?.remove();
                Auth.showBanModal(data.ban);
            } else if (data && data.status && data.token) {
                try { localStorage.removeItem('musifystar_active_ban'); } catch(e) {}
                Auth.token = data.token;
                Auth.currentUser = data.user;
                if (remember) {
                    localStorage.setItem('musifystar_auth_token', data.token);
                    localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                    sessionStorage.removeItem('musifystar_auth_token');
                    sessionStorage.removeItem('musifystar_auth_user');
                } else {
                    sessionStorage.setItem('musifystar_auth_token', data.token);
                    sessionStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                    localStorage.removeItem('musifystar_auth_token');
                    localStorage.removeItem('musifystar_auth_user');
                }
                showToast('Selamat datang, ' + data.user.username + '!');
                gid('header-auth-dropdown-wrapper')?.remove();
                Auth.updateHeaderUI();

                if (data.ban && (data.ban.isBanned || data.ban.isWarning)) {
                    Auth.showBanModal(data.ban);
                }
            } else {
                showToast(data?.message || 'Login gagal, periksa data Anda');
            }
        } catch (err) {
            showToast('Terjadi kesalahan jaringan');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i data-lucide="log-in" class="w-3.5 h-3.5"></i><span>Login</span>';
                if (window.lucide && typeof window.lucide.createIcons === 'function') try{ window.lucide.createIcons(); }catch(err){}
            }
        }
    },

    async handleRegister(e, prefix) {
        if (e && e.preventDefault) e.preventDefault();
        prefix = prefix || 'header-';
        var username = (gid(prefix + 'auth-reg-username')?.value || '').trim();
        var email = (gid(prefix + 'auth-reg-email')?.value || '').trim();
        var password = (gid(prefix + 'auth-reg-password')?.value || '').trim();

        if (password.length < 6) {
            showToast('Password minimal 6 karakter/huruf');
            return;
        }

        var btn = gid(prefix + 'auth-reg-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Mendaftarkan...</span>';
            if (window.lucide && typeof window.lucide.createIcons === 'function') try{ window.lucide.createIcons(); }catch(err){}
        }

        try {
            var res = await fetch('/api/user-auth?action=register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, email: email, password: password })
            });
            var data = await res.json();
            if (data && data.status && data.token) {
                Auth.token = data.token;
                Auth.currentUser = data.user;
                localStorage.setItem('musifystar_auth_token', data.token);
                localStorage.setItem('musifystar_auth_user', JSON.stringify(data.user));
                showToast('Pendaftaran berhasil! Selamat datang, ' + data.user.username);
                gid('header-auth-dropdown-wrapper')?.remove();
                Auth.updateHeaderUI();
            } else {
                showToast(data?.message || 'Pendaftaran gagal');
            }
        } catch (err) {
            showToast('Terjadi kesalahan koneksi');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i data-lucide="user-check" class="w-3.5 h-3.5"></i><span>Daftar Akun</span>';
                if (window.lucide && typeof window.lucide.createIcons === 'function') try{ window.lucide.createIcons(); }catch(err){}
            }
        }
    },

    async logout(notify = true) {
        if (Auth.token) {
            try {
                fetch('/api/user-auth?action=logout', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + Auth.token }
                });
            } catch(e) {}
        }
        Auth.token = null;
        Auth.currentUser = null;
        Auth.activeBannedUser = null;
        localStorage.removeItem('musifystar_auth_token');
        localStorage.removeItem('musifystar_auth_user');
        localStorage.removeItem('musifystar_active_ban');
        sessionStorage.removeItem('musifystar_auth_token');
        sessionStorage.removeItem('musifystar_auth_user');
        gid('header-auth-dropdown-wrapper')?.remove();
        Auth.updateHeaderUI();
        if (notify) showToast('Anda telah keluar dari akun');
    },

    showBanModal(ban) {
        if (!ban) return;
        var existing = gid('user-banned-banner-modal');
        if (existing) existing.remove();

        var isIpBanned = !!(ban.isIpBanned || ban.ipBanned);
        var isBanned = !!(ban.isBanned || isIpBanned);

        var titleText = isIpBanned ? 'ALAMAT IP DIBANNED' : (isBanned ? 'AKUN ANDA DIBANNED' : 'PERINGATAN DARI ADMIN');
        var iconClass = isIpBanned ? 'text-red-500 animate-pulse' : (isBanned ? 'text-rose-500 animate-pulse' : 'text-amber-400 animate-bounce');
        var iconName = isIpBanned ? 'wifi-off' : (isBanned ? 'shield-alert' : 'alert-triangle');
        var borderClass = isIpBanned ? 'border-red-600/70 shadow-red-600/40' : (isBanned ? 'border-rose-500/50 shadow-rose-500/30' : 'border-amber-500/50 shadow-amber-500/30');
        var badgeClass = isIpBanned ? 'bg-red-600/30 text-red-200 border-red-500/60' : (isBanned ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : 'bg-amber-500/20 text-amber-300 border-amber-500/40');

        var banTypeLabel = isIpBanned ? 'BANNED IP ADDRESS (BLACKLIST)' : 'dibanned permanen';
        if (!isIpBanned) {
            if (ban.banType === 'temporary') {
                banTypeLabel = 'dibanned sementara';
            } else if (ban.banType === 'warning') {
                banTypeLabel = 'peringatan';
            }
        } else {
            if (ban.banType === 'temporary') {
                banTypeLabel = 'IP DIBANNED SEMENTARA';
            }
        }

        var durationInfo = '';
        if (ban.banDurationText) {
            durationInfo = `<p class="text-xs sm:text-sm font-bold text-amber-300 tracking-wide mt-1">DURASI DIBANNED : ${ban.banDurationText}</p>`;
        } else if (ban.banType === 'permanent' || isIpBanned) {
            durationInfo = `<p class="text-xs sm:text-sm font-bold text-rose-400 tracking-wide mt-1">DURASI DIBANNED : Permanen</p>`;
        }

        var expiresInfo = '';
        if (ban.banExpiresAt) {
            try {
                var expDate = new Date(ban.banExpiresAt);
                var dateStr = expDate.toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, ':');
                expiresInfo = `<p class="text-[11px] font-semibold text-white/70 mt-0.5">Berlaku ${dateStr} WIB</p>`;
            } catch(e){}
        }

        var ipNotice = isIpBanned && ban.ip ? `<p class="text-xs font-mono text-red-300 bg-black/50 py-1.5 px-3 rounded-lg border border-red-500/30 inline-block">🌐 Target IP: ${ban.ip}</p>` : '';

        var modal = document.createElement('div');
        modal.id = 'user-banned-banner-modal';
        modal.dataset.banCategory = isIpBanned ? 'ip' : 'account';
        modal.className = 'fixed inset-0 z-[999999] bg-black/95 backdrop-blur-2xl flex items-center justify-center p-4 select-none pointer-events-auto';
        modal.innerHTML = `
            <div class="relative w-full max-w-md bg-[#12141c] border ${borderClass} rounded-3xl p-6 shadow-2xl text-center space-y-5 animate-scaleIn">
                <div class="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto shadow-inner">
                    <i data-lucide="${iconName}" class="w-9 h-9 ${iconClass}"></i>
                </div>

                <div class="space-y-2">
                    <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider border ${badgeClass}">
                        <span class="w-2 h-2 rounded-full ${isBanned ? 'bg-rose-500' : 'bg-amber-400'} animate-ping"></span>
                        <span>${banTypeLabel}</span>
                    </div>
                    <h2 class="text-xl sm:text-2xl font-black text-white tracking-tight">${titleText}</h2>
                    ${ipNotice}
                    ${durationInfo}
                    ${expiresInfo}
                </div>

                <div class="p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-left space-y-1.5 shadow-inner">
                    <span class="text-[10px] font-bold text-white/50 uppercase tracking-wider block">ALASAN DIBAN</span>
                    <p class="text-xs sm:text-sm text-white/90 leading-relaxed font-medium whitespace-pre-wrap">${ban.banReason || 'Jaringan / IP Address Anda telah dimasukkan ke dalam daftar hitam (blacklist) oleh admin.'}</p>
                </div>

                <div class="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-[11px] text-rose-300/80 leading-snug">
                    ${isIpBanned ? 'Akses jaringan dari IP Address ini diblokir total oleh server. Hubungi administrator jika Anda merasa ini kekeliruan.' : 'Akun ini dibanned oleh sistem dan tidak dapat dipulihkan, silahkan anda keluar dari akun ini thankyou'}
                </div>

                <div class="space-y-2">
                    <button onclick="Auth.checkBanStatusNow()" class="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-500 hover:from-emerald-600 hover:to-sky-600 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 active:scale-95 transition-all cursor-pointer">
                        <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                        <span>${isIpBanned ? 'Cek Status IP' : 'Cek Status Akun'}</span>
                    </button>
                    ${!isIpBanned ? `<button onclick="Auth.logoutAndReload()" class="w-full py-3 px-4 rounded-2xl bg-white/10 hover:bg-white/20 text-white/80 hover:text-white font-bold text-xs flex items-center justify-center gap-2 border border-white/10 active:scale-95 transition-all cursor-pointer">
                        <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
                        <span>LOGOUT AKUN</span>
                    </button>` : ''}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            try { window.lucide.createIcons(); } catch(e){}
        }

        // Auto polling check every 5 seconds while banner is visible
        if (window._banModalPollTimer) clearInterval(window._banModalPollTimer);
        window._banModalPollTimer = setInterval(function() {
            if (!gid('user-banned-banner-modal')) {
                clearInterval(window._banModalPollTimer);
                return;
            }
            Auth.checkBanStatusNow(true);
        }, 5000);
    },

    async checkBanStatusNow(silent = false) {
        try {
            var isExplicitlyUnbanned = false;
            var modal = gid('user-banned-banner-modal');
            var isIpBan = modal ? modal.dataset.banCategory === 'ip' : false;

            if (isIpBan) {
                var resIp = await fetch('/api/user-auth?action=me', { cache: 'no-store' });
                var dataIp = await resIp.json();
                if (dataIp && dataIp.status && !dataIp.ipBanned && (!dataIp.ban || !dataIp.ban.isIpBanned)) {
                    isExplicitlyUnbanned = true;
                }
            } else {
                if (Auth.token) {
                    var res = await fetch('/api/user-auth?action=me', {
                        headers: { 'Authorization': 'Bearer ' + Auth.token },
                        cache: 'no-store'
                    });
                    var data = await res.json();
                    if (data && data.status && data.authenticated && !data.banned && (!data.ban || (!data.ban.isBanned && !data.ban.isWarning))) {
                        isExplicitlyUnbanned = true;
                    }
                } else if (Auth.activeBannedUser && (Auth.activeBannedUser.username || Auth.activeBannedUser.userId || Auth.activeBannedUser.email)) {
                    var url = '/api/user-auth?action=check_account_ban' +
                        '&username=' + encodeURIComponent(Auth.activeBannedUser.username || '') +
                        '&userId=' + encodeURIComponent(Auth.activeBannedUser.userId || '') +
                        '&email=' + encodeURIComponent(Auth.activeBannedUser.email || '');
                    var resBan = await fetch(url, { cache: 'no-store' });
                    var dataBan = await resBan.json();
                    if (dataBan && dataBan.status && dataBan.banned === false) {
                        isExplicitlyUnbanned = true;
                    }
                }
            }

            if (isExplicitlyUnbanned) {
                if (window._banModalPollTimer) clearInterval(window._banModalPollTimer);
                Auth.activeBannedUser = null;
                try { localStorage.removeItem('musifystar_active_ban'); } catch(e) {}
                if (modal) modal.remove();
                if (typeof showToast === 'function') {
                    showToast('Selamat! Blokir / Banned akun Anda telah dibuka oleh administrator.');
                }
                setTimeout(function() { window.location.reload(); }, 600);
            } else if (!silent) {
                if (typeof showToast === 'function') {
                    showToast('Status Anda masih dalam sanksi dibanned / blacklist.');
                }
            }
        } catch(e) {
            if (!silent && typeof showToast === 'function') {
                showToast('Gagal terhubung ke server');
            }
        }
    },

    logoutAndReload() {
        if (window._banModalPollTimer) clearInterval(window._banModalPollTimer);
        if (window._realtimeBanMonitorTimer) clearInterval(window._realtimeBanMonitorTimer);
        Auth.activeBannedUser = null;
        Auth.currentUser = null;
        Auth.token = null;
        try {
            localStorage.removeItem('musifystar_auth_token');
            localStorage.removeItem('musifystar_auth_user');
            sessionStorage.removeItem('musifystar_auth_token');
            sessionStorage.removeItem('musifystar_auth_user');
            localStorage.removeItem('musifystar_active_ban');
        } catch(e) {}
        var modal = gid('user-banned-banner-modal');
        if (modal) modal.remove();
        setTimeout(function() {
            window.location.reload();
        }, 50);
    }
};

window.Auth = Auth;