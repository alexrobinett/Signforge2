/**
 * Approve's confirmation (#115): exactly what the request pinned, its drafts at their versions, the
 * screens it switches now, and the spots still holding their template's sample text, which pressing
 * acknowledges exactly as listed (#392's `allowSample`). Approving publishes those drafts as the person.
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
import { type ApprovalItem, pinWords, reachWords } from '~/lib/approvals';
import { useOpenerFocus } from '~/lib/opener-focus';
import { useAppStore } from '~/state/provider';

export function ApproveDialog({ item, orgId }: { item: ApprovalItem; orgId: string }) {
  const approve = useAppStore((s) => s.approveRequest);
  const cancel = useAppStore((s) => s.cancelApprove);
  const returnFocus = useOpenerFocus();
  const { check } = item;
  const { request, samples } = check;
  return (
    <AlertDialog open onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve and publish?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>Publishes exactly these drafts, at these versions, as you. If one has changed since it was asked for, nothing is published.</p>
              <ul className="list-disc space-y-1 pl-5 text-foreground" aria-label="The drafts it publishes">
                {request.drafts.map((d) => (
                  <li key={`${d.kind}:${d.id}`}>{pinWords(check, d)}</li>
                ))}
              </ul>
              <p>Screens: {reachWords(check)}.</p>
              {samples.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">Still showing their template's sample text, which approving publishes anyway:</p>
                  <ul className="list-disc space-y-1 pl-5" aria-label="Sample text it publishes">
                    {samples.map((x) => (
                      <li key={x.spotId}>
                        {x.name}, version {x.version}: {x.fields.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button onClick={() => void approve(orgId, item)}>{samples.length ? 'Approve and publish anyway' : 'Approve and publish'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
