import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RadioActivityPage } from "../../../frontend/src/components/RadioActivityPage";
import { useRadioJobFeed } from "../../../frontend/src/hooks/useRadioJobFeed";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Activity() {
  const feed = useRadioJobFeed();
  return <RadioActivityPage feed={feed} connection="live" health={null} />;
}

export function RadioActivityFixture() {
  return (
    <QueryClientProvider client={client}>
      <Activity />
    </QueryClientProvider>
  );
}
