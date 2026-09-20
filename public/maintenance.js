// ==========================================
// MusifyStar Maintenance Mode Controller
// Handles real-time cross-device sync & playback blocking
// ==========================================

var Maintenance = {
    isActive: false,
    config: {
        enabled: false,
        title: 'Pemeliharaan Sistem Musik',
        message: 'Sistem saat ini sedang dalam proses pemeliharaan dan peningkatan server besar. Pemutaran lagu dihentikan sementara agar update berjalan optimal.',
        estimatedEndTime: '',
        allowAdminBypass: true,
        updatedAt: null
    },
    hasChecked: false,
    checkInterval: null,
    isCheckingNow: false,

    init() {
        // Initial fetch of maintenance status
        Maintenance.checkStatus(function(active) {
            Maintenance.updateUI(active);
        });

        // Periodic sync across all open devices / browser tabs (every 20 seconds)
        if (Maintenance.checkInterval) clearInterval(Maintenance.checkInterval);
        Maintenance.checkInterval = setInterval(function() {
            Maintenance.checkStatus(function(active, prevActive) {
                if (active !== prevActive) {
                    Maintenance.updateUI(active);
                    // If maintenance was just turned on while audio was playing, pause it and alert
                    if (active && typeof AU !== 'undefined' && AU && !AU.paused) {
                        Maintenance.blockIfActive({ autoTriggered: true });
                    }
                }
            });
        }, 20000);
    },

    async checkStatus(callback) {
        if (Maintenance.isCheckingNow) return;
        Maintenance.isCheckingNow = true;

        var prevActive = Maintenance.isActive;

        try {
            var res = await fetch('/api/maintenance?t=' + Date.now());
            var data = await res.json();

            if (data && typeof data === 'object') {
                Maintenance.isActive = Boolean(data.maintenance || data.enabled);
                Maintenance.config = {
                    enabled: Maintenance.isActive,
                    title: data.title || 'Pemeliharaan Sistem Musik',
                    message: data.message || 'Sistem saat ini sedang dalam proses pemeliharaan dan peningkatan server besar.',
                    estimatedEndTime: data.estimatedEndTime || '',
                    allowAdminBypass: data.allowAdminBypass !== false,
                    updatedAt: data.updatedAt || null
                };
            }
            Maintenance.hasChecked = true;
        } catch (err) {
            // Keep previous state on network error
        } finally {
            Maintenance.isCheckingNow = false;
            if (typeof callback === 'function') {
                callback(Maintenance.isActive, prevActive);
            }
        }
    },

    // Check if music playback should be blocked
    blockIfActive(options) {
        options = options || {};

        // If admin bypass is allowed and current session is authenticated admin
        if (Maintenance.config.allowAdminBypass && typeof sessionStorage !== 'undefined') {
            var adminToken = sessionStorage.getItem('musifystar_admin_token');
            if (adminToken) {
                // Admin can test/play songs even during maintenance
                return false;
            }
        }

        if (Maintenance.isActive) {
            // Pause any running audio
            if (typeof AU !== 'undefined' && AU) {
                try { AU.pause(); } catch(e){}
            }
            if (typeof S !== 'undefined' && S) {
                S.ip = false;
                S.il = false;
                if (typeof UB === 'function') UB();
            }

            // Open the Maintenance Modal / Overlay
            Maintenance.openModal();

            if (typeof showToast === 'function' && !options.silent) {
                showToast('🛠️ Pemutaran lagu dijeda: Mode Pemeliharaan Aktif');
            }

            return true;
        }

        return false;
    },

    // Update Banner (Placed below PENGUMUMAN banner) and badges
    updateUI(active) {
        // Clean up any legacy floating banner at the top of the viewport
        var oldBanner = document.getElementById('music-maintenance-banner');
        if (oldBanner) {
            oldBanner.remove();
        }

        var slot = document.getElementById('maintenance-banner-slot');
        if (!slot) {
            var broadcastSlot = document.getElementById('broadcast-announcement-slot');
            if (broadcastSlot && broadcastSlot.parentNode) {
                slot = document.createElement('div');
                slot.id = 'maintenance-banner-slot';
                broadcastSlot.parentNode.insertBefore(slot, broadcastSlot.nextSibling);
            }
        }

        if (slot) {
            if (active) {
                var estBadge = Maintenance.config.estimatedEndTime 
                    ? `<span class="opacity-90 font-mono text-[10px] ml-1.5 px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">(${Maintenance.config.estimatedEndTime})</span>` 
                    : '';
                var title = Maintenance.config.title || 'Mode Pemeliharaan Aktif';
                var message = Maintenance.config.message || 'Pemutaran musik dijeda sementara untuk update server.';

                slot.innerHTML = `
                <div class="mb-4 p-4 sm:p-5 rounded-2xl border transition-all duration-500 overflow-hidden relative shadow-xl" style="background: radial-gradient(circle at 80% 20%, rgba(245, 158, 11, 0.22) 0%, rgba(20, 24, 33, 0.96) 85%); border-color: rgba(245, 158, 11, 0.4); box-shadow: 0 10px 30px -10px rgba(245, 158, 11, 0.3);">
                    <div class="flex items-start gap-3.5 relative z-10">
                        <div class="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl flex items-center justify-center shrink-0 border shadow-md" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; border-color: rgba(245, 158, 11, 0.4);">
                            <i data-lucide="wrench" class="w-5 h-5 sm:w-6 sm:h-6 animate-pulse"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
                                <span class="text-[10px] sm:text-[11px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border inline-flex items-center gap-1.5" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border-color: rgba(245, 158, 11, 0.35);">
                                    <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                                    <span>MODE PEMELIHARAAN</span>
                                    ${estBadge}
                                </span>
                                <button type="button" onclick="Maintenance.openModal()" class="px-3 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 hover:text-white text-[11px] font-bold shrink-0 active:scale-95 transition-all cursor-pointer flex items-center gap-1">
                                    <i data-lucide="info" class="w-3.5 h-3.5"></i>
                                    <span>Detail</span>
                                </button>
                            </div>
                            <h3 class="text-sm sm:text-base font-black text-white tracking-tight mt-0.5">${title}</h3>
                            <p class="text-xs sm:text-sm text-white/80 mt-1 leading-relaxed font-sans">${message}</p>
                        </div>
                    </div>
                </div>`;
                if (window.lucide) lucide.createIcons();
            } else {
                slot.innerHTML = '';
                Maintenance.closeModal();
            }
        } else if (!active) {
            Maintenance.closeModal();
        }

        // Also update Admin Panel badges if open
        var adminBadge = document.getElementById('admin-maintenance-tab-badge');
        if (adminBadge) {
            adminBadge.classList.toggle('hidden', !active);
        }
        var adminHeaderBadge = document.getElementById('admin-header-maintenance-badge');
        if (adminHeaderBadge) {
            adminHeaderBadge.classList.toggle('hidden', !active);
        }
    },

    // Modal popup explaining maintenance mode
    openModal() {
        var existing = document.getElementById('musifystar-maintenance-modal');
        if (existing) existing.remove();

        var conf = Maintenance.config;
        var estText = conf.estimatedEndTime 
            ? `<div class="mt-3 p-3 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center gap-2.5 text-xs text-amber-300">
                <i data-lucide="clock" class="w-4 h-4 shrink-0"></i>
                <div>
                    <span class="font-bold">Estimasi Selesai:</span>
                    <span class="font-mono ml-1 font-semibold">${conf.estimatedEndTime}</span>
                </div>
               </div>` 
            : '';

        var modal = document.createElement('div');
        modal.id = 'musifystar-maintenance-modal';
        modal.className = 'fixed inset-0 z-[600] flex items-center justify-center p-4 bg-black/85 backdrop-blur-xl animate-fade-in';
        modal.innerHTML = `
        <div class="w-full max-w-md bg-[#12141c] border border-amber-500/40 rounded-3xl shadow-2xl overflow-hidden relative p-6 sm:p-7 text-white" style="box-shadow: 0 25px 50px -12px rgba(245, 158, 11, 0.3);">
            
            <!-- Close Button -->
            <button onclick="Maintenance.closeModal()" class="absolute top-5 right-5 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 flex items-center justify-center text-white/70 hover:text-white transition-all cursor-pointer">
                <i data-lucide="x" class="w-4 h-4"></i>
            </button>

            <!-- Maintenance Animated Icon -->
            <div class="text-center mb-5 pt-2">
                <div class="w-16 h-16 mx-auto mb-3.5 rounded-2xl bg-gradient-to-tr from-amber-500 via-rose-500 to-amber-600 flex items-center justify-center text-white shadow-xl shadow-amber-500/30 border border-amber-400/40 relative">
                    <i data-lucide="wrench" class="w-8 h-8 animate-pulse"></i>
                    <span class="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-3.5 w-3.5 bg-amber-500 border-2 border-[#12141c]"></span>
                    </span>
                </div>
                
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 mb-2">
                    <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                    Mode Pemeliharaan Sistem
                </span>

                <h2 class="text-lg sm:text-xl font-black text-white tracking-tight">${conf.title}</h2>
            </div>

            <!-- Message Card -->
            <div class="p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-xs sm:text-sm text-white/80 leading-relaxed font-sans text-center">
                ${conf.message}
            </div>

            ${estText}

            <!-- Device Sync Note -->
            <p class="text-[11px] text-white/50 text-center mt-3 flex items-center justify-center gap-1.5">
                <i data-lucide="smartphone" class="w-3.5 h-3.5 text-white/40"></i>
                <span>Status ini berlaku otomatis di semua perangkat pengguna</span>
            </p>

            <!-- Actions -->
            <div class="mt-6 space-y-2">
                <button type="button" id="btn-check-maintenance-status" onclick="Maintenance.manualCheckFromModal()" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-600 hover:to-rose-700 active:scale-95 text-white font-bold text-xs sm:text-sm shadow-lg shadow-amber-500/25 transition-all flex items-center justify-center gap-2 cursor-pointer">
                    <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                    <span>Cek Status Server</span>
                </button>
                
                <button type="button" onclick="Maintenance.closeModal()" class="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 active:scale-95 text-white/60 hover:text-white text-xs font-semibold transition-all cursor-pointer">
                    Tutup Layar
                </button>
            </div>
        </div>`;

        document.body.appendChild(modal);
        if (window.lucide) lucide.createIcons();
    },

    closeModal() {
        var modal = document.getElementById('musifystar-maintenance-modal');
        if (modal) modal.remove();
    },

    async manualCheckFromModal() {
        var btn = document.getElementById('btn-check-maintenance-status');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> <span>Memeriksa server...</span>';
            if (window.lucide) lucide.createIcons();
        }

        await Maintenance.checkStatus(function(active) {
            Maintenance.updateUI(active);
            if (!active) {
                Maintenance.closeModal();
                if (typeof showToast === 'function') {
                    showToast('🎉 Pemeliharaan server telah selesai! Silakan putar musik kembali.');
                }
            } else {
                if (typeof showToast === 'function') {
                    showToast('Server masih dalam pemeliharaan. Harap tunggu sebentar.');
                }
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> <span>Cek Status Server</span>';
                    if (window.lucide) lucide.createIcons();
                }
            }
        });
    }
};

// Start maintenance listener when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', Maintenance.init);
} else {
    Maintenance.init();
}
