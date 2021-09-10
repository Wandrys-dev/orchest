import React from "react";
import { useHistory, useParams } from "react-router-dom";
import io from "socket.io-client";

import {
  makeRequest,
  PromiseManager,
  makeCancelable,
} from "@orchest/lib-utils";
import {
  MDCButtonReact,
  MDCLinearProgressReact,
  MDCDrawerReact,
} from "@orchest/lib-mdc";

import type { PipelineJson, TViewPropsWithRequiredQueryArgs } from "@/types";
import {
  getPipelineJSONEndpoint,
  createOutgoingConnections,
  filterServices,
} from "@/utils/webserver-utils";
import { useOrchest, OrchestSessionsConsumer } from "@/hooks/orchest";
import { Layout } from "@/components/Layout";
import LogViewer from "@/pipeline-view/LogViewer";
import { generatePathFromRoute, siteMap, toQueryString } from "@/Routes";
import { useLocationQuery, useLocationState } from "@/hooks/useCustomLocation";

export type ILogsViewProps = TViewPropsWithRequiredQueryArgs<
  "pipeline_uuid" | "project_uuid"
>;

const LogsView: React.FC<ILogsViewProps> = (props) => {
  const history = useHistory<{ isReadOnly: boolean }>();
  const { dispatch, get } = useOrchest();

  const { projectId, pipelineId } = useParams<{
    projectId: string;
    pipelineId: string;
  }>();

  const [jobId, runId] = useLocationQuery(["job_uuid", "run_uuid"]);
  const [isReadOnly] = useLocationState(["isReadOnly"]);

  const [promiseManager] = React.useState(new PromiseManager());

  const [selectedLog, setSelectedLog] = React.useState(undefined);
  const [logType, setLogType] = React.useState(undefined);
  const [sortedSteps, setSortedSteps] = React.useState(undefined);
  const [pipelineJson, setPipelineJson] = React.useState(undefined);
  const [sio, setSio] = React.useState(undefined);
  const [job, setJob] = React.useState(undefined);

  // Conditional fetch session
  let session = !jobId
    ? get.session({ pipeline_uuid: pipelineId, project_uuid: projectId })
    : undefined;

  React.useEffect(() => {
    connectSocketIO();
    fetchPipeline();

    if (jobId) {
      fetchJob();
    }

    return () => {
      promiseManager.cancelCancelablePromises();
      disconnectSocketIO();
    };
  }, []);

  React.useEffect(() => {
    // Preselect first step, or service (if no step exists)
    if (
      pipelineJson != undefined &&
      pipelineJson != undefined &&
      selectedLog == undefined
    ) {
      if (sortedSteps.length > 0) {
        setSelectedLog(sortedSteps[0].uuid);
        setLogType("step");
      } else {
        let services = getServices();
        if (Object.keys(services).length > 0) {
          setSelectedLog(services[Object.keys(services)[0]].name);
          setLogType("service");
        }
      }
    }
  }, [sortedSteps, session]);

  const connectSocketIO = () => {
    // disable polling
    let socket = io.connect("/pty", { transports: ["websocket"] });

    socket.on("connect", () => {
      setSio(socket);
    });
  };

  const disconnectSocketIO = () => {
    if (sio) {
      sio.disconnect();
    }
  };

  const topologicalSort = (pipelineSteps) => {
    let sortedStepKeys = [];

    pipelineSteps = createOutgoingConnections(pipelineSteps);

    let conditionalAdd = (step) => {
      // add iff all parents are already in the sortedStepKeys
      let parentsAdded = true;
      for (let x = 0; x < step.incoming_connections.length; x++) {
        if (sortedStepKeys.indexOf(step.incoming_connections[x]) == -1) {
          parentsAdded = false;
          break;
        }
      }

      if (sortedStepKeys.indexOf(step.uuid) == -1 && parentsAdded) {
        sortedStepKeys.push(step.uuid);
      }
    };

    // Add self and children (breadth first)
    let addSelfAndChildren = (step) => {
      conditionalAdd(step);

      for (let x = 0; x < step.outgoing_connections.length; x++) {
        let childStepUUID = step.outgoing_connections[x];
        let childStep = pipelineSteps[childStepUUID];

        conditionalAdd(childStep);
      }

      // Recurse down
      for (let x = 0; x < step.outgoing_connections.length; x++) {
        let childStepUUID = step.outgoing_connections[x];
        addSelfAndChildren(pipelineSteps[childStepUUID]);
      }
    };

    // Find roots
    for (let stepUUID in pipelineSteps) {
      let step = pipelineSteps[stepUUID];
      if (step.incoming_connections.length == 0) {
        addSelfAndChildren(step);
      }
    }

    return sortedStepKeys.map((stepUUID) => pipelineSteps[stepUUID]);
  };

  const setHeaderComponent = (pipelineName) => {
    dispatch({
      type: "pipelineSet",
      payload: {
        pipeline_uuid: pipelineId,
        project_uuid: projectId,
        pipelineName: pipelineName,
      },
    });
  };

  const getServices = () => {
    let services = {};

    // If there is no job_uuid use the session for
    // fetch the services
    if (jobId == undefined && session && session.user_services) {
      services = session.user_services;
    }
    // if there is a job_uuid use the job pipeline to
    // fetch the services.
    else if (job?.pipeline_definition.services !== undefined) {
      services = job.pipeline_definition.services;
    }

    let scope = jobId ? "noninteractive" : "interactive";
    return filterServices(services, scope);
  };

  const generateServiceItems = () => {
    let serviceItems = [];
    let services = getServices();

    for (let key of Object.keys(services)) {
      let service = services[key];

      serviceItems.push({
        type: "service",
        identifier: service.name,
        label: (
          <>
            <span className="log-title">{service.name}</span>
            <br />
            <span>{service.image}</span>
          </>
        ),
      });
    }

    return serviceItems;
  };

  const fetchPipeline = () => {
    let pipelineJSONEndpoint = getPipelineJSONEndpoint(
      pipelineId,
      projectId,
      jobId,
      runId
    );

    let pipelinePromise = makeCancelable(
      makeRequest("GET", pipelineJSONEndpoint),
      promiseManager
    );

    pipelinePromise.promise.then((response) => {
      let result: {
        pipeline_json: string;
        success: boolean;
      } = JSON.parse(response);

      if (result.success) {
        let fetchedPipeline: PipelineJson = JSON.parse(result.pipeline_json);
        setPipelineJson(fetchedPipeline);

        let sortedSteps = topologicalSort(fetchedPipeline.steps);
        setSortedSteps(sortedSteps);
        setHeaderComponent(fetchedPipeline.name);
      } else {
        console.warn("Could not load pipeline.json");
        console.log(result);
      }
    });
  };

  const fetchJob = () => {
    makeRequest("GET", `/catch/api-proxy/api/jobs/${jobId}`).then(
      (response: string) => {
        try {
          setJob(JSON.parse(response));
        } catch (error) {
          console.error("Failed to fetch job.", error);
        }
      }
    );
  };

  const hasLoaded = () => {
    return (
      pipelineJson &&
      sortedSteps !== undefined &&
      sio &&
      (jobId === undefined || job)
    );
  };

  const close = () => {
    history.push({
      pathname: generatePathFromRoute(siteMap.pipeline.path, {
        projectId: projectId,
        pipelineId: pipelineId,
      }),
      state: { isReadOnly },
      search: toQueryString({
        job_uuid: jobId,
        run_uuid: runId,
      }),
    });
  };

  const clickLog = (_, item) => {
    setSelectedLog(item.identifier);
    setLogType(item.type);
  };

  const getItemIndex = (items, access, value) => {
    for (let x = 0; x < items.length; x++) {
      if (access(items[x]) == value) {
        return x;
      }
    }
    return -1;
  };

  let rootView = undefined;

  if (hasLoaded()) {
    let steps = [];

    for (let step of sortedSteps) {
      steps.push({
        identifier: step.uuid,
        type: "step",
        label: (
          <>
            <span className="log-title">{step.title}</span>
            <br />
            <span>{step.file_path}</span>
          </>
        ),
      });
    }

    let dynamicLogViewerProps = {};
    if (logType == "step") {
      dynamicLogViewerProps["stepId"] = selectedLog;
    } else if (logType == "service") {
      dynamicLogViewerProps["serviceName"] = selectedLog;
    }

    let services = generateServiceItems();

    rootView = (
      <div className="logs">
        <div className="log-selector">
          <div className="log-section">
            <i className="material-icons">device_hub</i>
            Step logs
          </div>
          {sortedSteps.length == 0 && (
            <i className="note">There are steps defined.</i>
          )}
          <MDCDrawerReact
            items={steps}
            selectedIndex={
              logType == "step"
                ? getItemIndex(steps, (step) => step.identifier, selectedLog)
                : -1
            }
            action={clickLog}
          />
          <div role="separator" className="mdc-list-divider" />
          <div className="log-section">
            <i className="material-icons">settings</i>
            Service logs
          </div>
          {!session && !job && (
            <i className="note">There is no active session.</i>
          )}
          {(session || job) && services.length == 0 && (
            <i className="note">There are no services defined.</i>
          )}
          <MDCDrawerReact
            items={services}
            selectedIndex={
              logType == "service"
                ? getItemIndex(
                    services,
                    (service) => service.identifier,
                    selectedLog
                  )
                : -1
            }
            action={clickLog}
          />
        </div>
        <div className="logs-xterm-holder">
          {selectedLog && logType && (
            <LogViewer
              key={selectedLog}
              sio={sio}
              pipelineId={pipelineId}
              projectId={projectId}
              jobId={jobId}
              runId={runId}
              {...dynamicLogViewerProps}
            />
          )}
        </div>

        <div className="top-buttons">
          <MDCButtonReact
            classNames={["close-button"]}
            icon="close"
            onClick={close}
          />
        </div>
      </div>
    );
  } else {
    rootView = <MDCLinearProgressReact />;
  }

  return (
    <OrchestSessionsConsumer>
      <Layout>
        <div className="view-page no-padding logs-view">{rootView}</div>
      </Layout>
    </OrchestSessionsConsumer>
  );
};

export default LogsView;
