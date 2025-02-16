import useSWR from "swr";

import { fetcher } from "@/utils/fetcher";
import type { STATUS } from "@/hooks/useAsync";
import { Example } from "@/types";

const useFetchExamples = (shouldFetch = true) => {
  const { data, error, isValidating } = useSWR<{
    creation_time: string;
    entries: Example[];
  }>(shouldFetch ? "/async/orchest-examples" : null, fetcher);
  const status: STATUS = !shouldFetch
    ? "IDLE"
    : isValidating
    ? "PENDING"
    : error
    ? "REJECTED"
    : "RESOLVED";

  return { data: data ? data.entries : null, status, error };
};

export { useFetchExamples };
