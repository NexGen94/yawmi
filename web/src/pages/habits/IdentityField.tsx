import { Field } from '../../ui/Field';

export const IDENTITY_MAX = 300;

export interface IdentityFieldProps {
  value: string;
  error?: string;
  onInput(value: string): void;
}

/** The identity sentence (feature 11): who the habit helps to become, in the person's own words.
 *  The field holds no suggestion; it shows on the habit's row and page once written. */
export function IdentityField({ value, error, onInput }: IdentityFieldProps) {
  return (
    <Field
      label="جملة الهوية"
      value={value}
      onInput={onInput}
      error={error}
      maxLength={IDENTITY_MAX}
      multiline
      hint="جملة قصيرة بكلمات صاحبها تصف ما تصيره العادة؛ تظهر تحت العنوان في القوائم."
    />
  );
}
