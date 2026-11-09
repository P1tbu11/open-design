/**
 * Commercial surface kill switch.
 *
 * One place that decides which promotional surfaces the web shell renders.
 * Every entry is `false` on purpose: this working copy ships without marketing,
 * growth, referral, campaign, survey, or upsell surfaces. Flip a single entry
 * back to `true` to restore exactly that one surface — each mount point reads
 * these flags directly, so no component needs editing.
 *
 * ## What belongs here
 *
 * A surface belongs here when its purpose is to sell, promote, recruit, or
 * extract feedback — i.e. removing it changes nothing about whether the user can
 * do their work. Home invite banners, referral cards, model-launch campaigns,
 * the NPS card, GitHub star chips, "what's new" highlights, and paid-tier
 * upgrade prompts all qualify.
 *
 * ## What does NOT belong here
 *
 * Functional gates. A dialog that resolves a promise the submit flow is
 * awaiting — `HomeAmrBalanceGateDialogs`, `AmrConcurrencyDialog`,
 * `AmrOwnerTopUpDialog` — is load-bearing: unmounting it leaves send hanging
 * forever. Those stay mounted so the flow can resolve; the switch only strips
 * their pitch (artwork, benefit lists, plan CTAs) and keeps the sentence that
 * says why the send stopped.
 *
 * `AmrArtifactUpgradeGate` is the one paid gate that is safe to remove whole:
 * its request path (`requestAmrArtifactUpgrade`) resolves to `proceed` when
 * nothing listens on the event, so dropping the gate lets the send through.
 */
export type CommercialSurface =
  | 'experienceSurvey'
  | 'invitePrompts'
  | 'githubStars'
  | 'referralProgram'
  | 'cmsCampaigns'
  | 'modelCampaigns'
  | 'upgradePrompts'
  | 'whatsNew'
  | 'subscriptionAnnouncements'
  | 'sharePrompts';

/**
 * Mutable on purpose: tests flip entries to exercise a surface, since the
 * default is `false` everywhere. Keep production reads behind
 * {@link commercialSurfaceEnabled} so the seam stays one function.
 */
export const COMMERCIAL_SURFACES: Record<CommercialSurface, boolean> = {
  /** NPS/CSAT card (`ExperienceSurvey`), armed by a delivered artifact. */
  experienceSurvey: false,
  /** Home invite banner, rail invite trigger, and the registration invite step. */
  invitePrompts: false,
  /** GitHub star chip in the entry top-right cluster. */
  githubStars: false,
  /** Referral programme notice and its entry context/provider. */
  referralProgram: false,
  /** CMS-delivered campaign touchpoints: modal, account badge, hover layer, test runtime. */
  cmsCampaigns: false,
  /** Model-launch campaign surfaces (the DeepSeek V4 window and its badge). */
  modelCampaigns: false,
  /** Paid-tier upsell: discount dialog, upgrade card CTA, plan buttons, benefits pitch. */
  upgradePrompts: false,
  /** Post-update highlights dialog. */
  whatsNew: false,
  /** Subscription-sunset announcement pushed through the message centre. */
  subscriptionAnnouncements: false,
  /** Share-to-community entry points and the post-export share guide. */
  sharePrompts: false,
};

/**
 * Whether one commercial surface may render. The single read path for every
 * mount point, so a surface can be restored in one edit.
 */
export function commercialSurfaceEnabled(surface: CommercialSurface): boolean {
  return COMMERCIAL_SURFACES[surface];
}
