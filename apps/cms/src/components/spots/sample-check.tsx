/**
 * Publish's question when spots in it still hold the sample copy New spot gave them (#360): it names
 * the fields, and offers Publish anyway or Edit first, never a refusal. In the shell, so the spot
 * editor, a playlist and the schedule all ask the same way (`sampleCheck` in src/state/publishing.ts).
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
import { useAppStore } from '~/state/provider';

export function SampleCheck() {
  const check = useAppStore((s) => s.publishing.sampleCheck);
  const publishAnyway = useAppStore((s) => s.publishAnyway);
  const editFirst = useAppStore((s) => s.editFirst);
  const drop = useAppStore((s) => s.dropSampleCheck);
  return (
    <AlertDialog open={check !== null} onOpenChange={(open) => !open && drop()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Publish sample text?</AlertDialogTitle>
          <AlertDialogDescription>{check?.words} Publish anyway?</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void editFirst()}>Edit first</AlertDialogCancel>
          <Button onClick={() => void publishAnyway()}>Publish anyway</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
