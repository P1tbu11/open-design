/**
 * 折叠块 —— 复用密度最高的原子:执行记录本身、每条 todo 抽屉、命令的输出块都是它。
 * 执行记录就是 Foldable 套 Foldable。
 *
 * 两个形态(设计稿):
 *  · flat  最外那层(壳),无框、标题加粗、展开后与正文之间有一条分隔线
 *  · boxed 抽屉层,有底有圆角
 *
 * 三条容易写错的地方:
 *  1. `expandable === false` 时**不出箭头、也打不开**(D35:本轮没有内容的 todo)。
 *     仍然用 `<details>` 而不是换成 div —— 结构一变,父层那些按嵌套层数算缩进的
 *     选择器就全部错位。
 *  2. **用户手点开的不能被重渲染复位**(模拟器踩过:每帧重画把折叠态拨回去)。
 *     所以不传 `open` 时用内部状态记住,不是每次渲染都把属性写回去。
 *  3. 耗时在箭头左边;没有耗时时箭头自己靠右(CSS 里靠 `margin-left:auto` 换手)。
 *  4. **「自动摊开的」和「用户手掀的」是两回事**(`lifecycleOpen`)。前者跑完要自己收,
 *     后者收不得。分辨这两者的判据是 `<details>` 那声 `toggle` 的**值**,不是它有没有来
 *     —— 详见 `handleToggle` 上方那段(OPEND-2557)。
 */
import {
  type MouseEvent,
  type ReactElement,
  type Ref,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FoldableProps } from './contract';
import { ChevronIcon } from './icons';
import styles from './record.module.css';

export const FOLD_CLOSE_MS = 140;
export const FOLD_EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

function prefersReducedMotion(): boolean {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function canAnimateCloseEnv(): boolean {
  if (prefersReducedMotion()) return false;
  return (
    (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.animate === 'function')
    || (typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function')
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    (ref as { current: T | null }).current = value;
  }
}

export function Foldable({
  summary,
  variant = 'boxed',
  elapsed,
  defaultOpen,
  lifecycleOpen,
  open,
  onToggle,
  expandable = true,
  scroll,
  stream,
  deferBody = false,
  busy,
  bodyRef,
  bodyClassName,
  className,
  children,
}: FoldableProps & { stream?: boolean; bodyRef?: Ref<HTMLDivElement>; className?: string }): ReactElement {
  const seedOpen = lifecycleOpen ?? Boolean(defaultOpen);
  const [selfOpen, setSelfOpen] = useState(seedOpen);
  const [bodyActivated, setBodyActivated] = useState(Boolean(seedOpen || open));
  /**
   * 用户自己动过这一条没有 —— 只服务 `lifecycleOpen`,别的路径不读它。
   * 一旦为真就不再复位:这只闩的寿命 = 这个组件实例的寿命。
   */
  const [userToggled, setUserToggled] = useState(false);
  const controlled = open != null;
  const hasBody = children != null && children !== false;
  const isOpen = expandable && hasBody && (controlled ? Boolean(open) : selfOpen);

  /**
   * 收起时的 140ms WAAPI 退场闩:逻辑 `isOpen` 先翻为 false,DOM `[open]` 暂留到
   * `body.animate(...)` 结束再撤下,避免 `<details>` 首帧直接把正文裁掉。
   * jsdom(无 `Element.prototype.animate`)与 `prefers-reduced-motion: reduce`
   * 下 `canAnimateCloseEnv()` 为假,退回同步撤 `[open]`。
   */
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen && prevIsOpen && expandable && hasBody && canAnimateCloseEnv()) {
      setClosing(true);
    } else if (isOpen && closing) {
      setClosing(false);
    }
  }

  const domOpen = isOpen || closing;
  const shouldMountBody = !deferBody || domOpen || bodyActivated;

  const internalBodyRef = useRef<HTMLDivElement | null>(null);
  const closeAnimRef = useRef<Animation | null>(null);
  const suppressCloseEchoRef = useRef(false);

  const setMergedBodyRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalBodyRef.current = node;
      assignRef(bodyRef, node);
    },
    [bodyRef],
  );

  useEffect(() => {
    if (isOpen && !bodyActivated) setBodyActivated(true);
  }, [bodyActivated, isOpen]);

  useLayoutEffect(() => {
    if (isOpen && closeAnimRef.current) {
      try { closeAnimRef.current.cancel(); } catch { /* noop */ }
      closeAnimRef.current = null;
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!closing) return;
    const bodyEl = internalBodyRef.current;
    if (!bodyEl || typeof bodyEl.animate !== 'function' || prefersReducedMotion()) {
      setClosing(false);
      return;
    }
    if (closeAnimRef.current) {
      try { closeAnimRef.current.cancel(); } catch { /* noop */ }
      closeAnimRef.current = null;
    }
    const anim = bodyEl.animate(
      [
        { opacity: 1, transform: 'translateY(0px)' },
        { opacity: 0, transform: 'translateY(-4px)' },
      ],
      {
        duration: FOLD_CLOSE_MS,
        easing: FOLD_EASE_OUT,
        fill: 'forwards',
      },
    );
    closeAnimRef.current = anim;
    let settled = false;
    const finish = () => {
      if (settled || closeAnimRef.current !== anim) return;
      settled = true;
      closeAnimRef.current = null;
      try { anim.cancel(); } catch { /* noop */ }
      suppressCloseEchoRef.current = true;
      setClosing(false);
    };
    anim.onfinish = finish;
    return () => {
      if (closeAnimRef.current === anim) {
        closeAnimRef.current = null;
        try { anim.cancel(); } catch { /* noop */ }
      }
    };
  }, [closing]);

  /**
   * 折叠态跟着**外面那件事的生命周期**走(可选接入):跑着的时候摊开,跑完收起来。
   *
   * `defaultOpen` 修不了这件事 —— 它只是初始值,状态翻面时没人再看它一眼。现场:一条
   * `in_progress` 的 todo 自动展开,翻成 completed 时 `TodoRow` 的 key 一个字没变
   * (`todo-${content}-${index}`),同一个实例、同一份 `selfOpen`,于是**跑完还摊着**。
   *
   * 不传 `lifecycleOpen` 的调用点走不到这里,行为和从前完全一样。
   * 传了 `open` 的受控方也走不到:折叠态在它自己手上(壳就是这么干的)。
   */
  useEffect(() => {
    if (lifecycleOpen == null || userToggled) return;
    setSelfOpen(lifecycleOpen);
  }, [lifecycleOpen, userToggled]);

  /*
   * ⚠️ **`<details>` 的 `toggle` 事件不区分是谁掀开的**(OPEND-2557 的真因,在壳那一层
   * 栽过一次:`ExecutionShell` 的 `onToggle`)。React 每次把 `open` 写回 DOM,浏览器都会
   * 照样派发一次 `toggle` —— 而**自动摊开的那一帧**就有这么一次。把那声回声当成
   * 「用户点过」,自动跟随会在整轮开始的第一帧就被永久禁用,表现是跑完永远不收。
   *
   * 判据是**值**,和壳那一层逐字同一条:自己写回去的那一次,`next` 必然等于此刻的状态;
   * 用户点的那一次,DOM 先自己翻面,`next` 必然相反。
   * 用 ref 读当前值而不是闭包 —— `handleToggle` 是 memo 过的,排到下一帧的回声
   * 从闭包里读到的会是过期的 `selfOpen`。
   *
   * (走到这里时 `expandable && hasBody` 必为真,所以 `selfOpen` 就是写进 DOM 的那个值。)
   */
  const selfOpenRef = useRef(selfOpen);
  selfOpenRef.current = selfOpen;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  const handleSummaryClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (deferBody && expandable && hasBody) setBodyActivated(true);
      if (!expandable || !hasBody || event.defaultPrevented) return;
      if (
        event.target instanceof Element
        && event.target.closest('button, a, input, select, textarea')
      ) {
        return;
      }
      if (!canAnimateCloseEnv()) return;

      if (closingRef.current) {
        event.preventDefault();
        if (closeAnimRef.current) {
          try { closeAnimRef.current.cancel(); } catch { /* noop */ }
          closeAnimRef.current = null;
        }
        suppressCloseEchoRef.current = false;
        setClosing(false);
        if (!controlled) {
          setUserToggled(true);
          setSelfOpen(true);
        }
        onToggle?.(true);
        return;
      }

      if (isOpenRef.current) {
        event.preventDefault();
        if (!controlled) {
          setUserToggled(true);
          setSelfOpen(false);
        }
        onToggle?.(false);
      }
    },
    [controlled, deferBody, expandable, hasBody, onToggle],
  );

  const handleToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;
      if (!expandable || !hasBody) {
        if (next) event.currentTarget.open = false;
        return;
      }
      if (closingRef.current && next) return;
      if (!next && suppressCloseEchoRef.current) {
        suppressCloseEchoRef.current = false;
        return;
      }
      if (next) setBodyActivated(true);
      if (!controlled) {
        if (next !== selfOpenRef.current) setUserToggled(true);
        setSelfOpen(next);
      }
      onToggle?.(next);
    },
    [controlled, expandable, hasBody, onToggle],
  );

  const classes = [
    styles.fold,
    variant === 'flat' ? styles.flat : null,
    expandable && hasBody ? null : styles.leaf,
    className ?? null,
  ].filter(Boolean).join(' ');

  return (
    <details
      className={classes}
      open={domOpen}
      data-closing={closing ? 'true' : undefined}
      aria-busy={busy || undefined}
      onToggle={handleToggle}
    >
      <summary onClick={handleSummaryClick}>
        <span className={styles.summaryContent} data-testid="chat-foldable-summary-content">
          {summary}
        </span>
        {/*
          * `!= null` 而不是真值判断:**空字符串要占住这个槽**。稿子给进行中的折叠行画的是
          * `<span class="ms"></span>` —— 槽在、值空,这样耗时落地那一刻箭头不会横跳
          * (空槽同样吃掉 `.meta + .chev { margin-left: 0 }` 那条)。
          * 不需要槽的调用方传 `undefined`,行为和从前一样。
          */}
        {elapsed != null ? (
          <span className={styles.meta} data-testid="chat-foldable-elapsed">{elapsed}</span>
        ) : null}
        {/* 没有东西可展开的时候给个箭头是在骗人 */}
        {expandable && hasBody ? (
          <span className={styles.chev} data-testid="chat-foldable-toggle"><ChevronIcon /></span>
        ) : null}
      </summary>
      {expandable && hasBody && shouldMountBody ? (
        <div
          ref={setMergedBodyRef}
          className={[
            styles.body,
            stream ? styles.stream : styles.stack,
            scroll ? styles.scroll : null,
            bodyClassName ?? null,
          ]
            .filter(Boolean).join(' ')}
        >
          {children}
        </div>
      ) : null}
    </details>
  );
}
