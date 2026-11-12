/** An outcome code (O1 to O12), in the face that keeps the letter O round: in the body face it reads as
 *  a zero («O10» looked like «010»). */
export function Code({ code }: { code: string }) {
  return (
    <bdi dir="ltr" class="code-latin">
      {code}
    </bdi>
  );
}
