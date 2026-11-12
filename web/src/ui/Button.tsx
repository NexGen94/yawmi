import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'className'> {
  /** primary: the one prominent action of a page (ink). quiet: everything else (default). */
  variant?: 'primary' | 'quiet';
  class?: string;
  children: ComponentChildren;
}

/** A button at least 44px tall. Labels are nouns of action («حفظ الصباح»), never imperatives. */
export function Button({ variant = 'quiet', type = 'button', class: extra, children, ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, extra].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type} class={cls}>
      {children}
    </button>
  );
}
