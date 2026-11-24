/**
 * Publish's question when spots in it still hold their template's sample text, as the server
 * records it (#360): it names the fields, and offers Publish anyway (sent again with `allowSample`)
 * or Edit first, never a refusal. In the shell, so the spot editor, a playlist, the schedule, a
 * takeover, ⌘K and the agent's drawer all ask the same way (`sampleCheck` in src/state/publishing.ts).
 */
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { useOpenerFocus } from '~/lib/opener-focus';
import { useAppStore } from '~/state/provider';

export function SampleCheck() {
  const words = useAppStore((s) => s.publishing.sampleCheck?.words);
  return words === undefined ? null : <OpenSampleCheck words={words} />;
}

function OpenSampleCheck({ words }: { words: string }) {
  const publishAnyway = useAppStore((s) => s.publishAnyway);
  const editFirst = useAppStore((s) => s.editFirst);
  const drop = useAppStore((s) => s.dropSampleCheck);
  // Focus goes back to what asked (it renders only once asked), Escape included; after ⌘K, the main region.
  const returnFocus = useOpenerFocus();
  return (
    <AlertDialog open onOpenChange={(open) => !open && drop()}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Publish sample text?</AlertDialogTitle>
          {/* Many spots or fields scroll here, so the buttons stay in view on a phone. */}
          <AlertDialogDescription className="max-h-60 overflow-y-auto">{words} Publish anyway?</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void editFirst()}>Edit first</AlertDialogCancel>
          <Button onClick={publishAnyway}>Publish anyway</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
