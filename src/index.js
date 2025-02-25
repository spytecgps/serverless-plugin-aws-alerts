const { merge, isString, isObject, union, upperFirst } = require('./helpers');
const Naming = require('./naming');
const ExternalStack = require('./external-stack');
const defaultDefinitions = require('./defaults/definitions');

const dashboards = require('./dashboards');

class AlertsPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    serverless.configSchemaHandler.defineFunctionProperties('aws', {
      properties: {
        alarms: {
          type: 'array',
        },
      },
    });

    this.awsProvider = this.serverless.getProvider('aws');
    this.providerNaming = this.awsProvider.naming;
    this.naming = new Naming();
    this.externalStack = new ExternalStack(serverless, options);

    this.hooks = {
      'package:compileEvents': this.compile.bind(this),
      'after:deploy:deploy': this.externalStack.afterDeployGlobal.bind(
        this.externalStack
      ),
      'before:remove:remove': this.externalStack.beforeRemoveGlobal.bind(
        this.externalStack
      ),
    };
  }

  getConfig() {
    return this.serverless.service.custom.alerts;
  }

  getDefinitions(config) {
    return merge({}, defaultDefinitions, config.definitions);
  }

  getAlarms(alarms, definitions) {
    if (!alarms) return [];

    return alarms.reduce((result, alarm) => {
      if (isString(alarm)) {
        const definition = definitions[alarm];

        if (!definition) {
          throw new Error(`Alarm definition ${alarm} does not exist!`);
        }

        result.push(
          Object.assign(
            {
              enabled: true,
              type: 'static',
            },
            definition,
            {
              name: alarm,
            }
          )
        );
      } else if (isObject(alarm)) {
        result.push(
          merge(
            {
              enabled: true,
              type: 'static',
            },
            definitions[alarm.name],
            alarm
          )
        );
      }

      return result;
    }, []);
  }

  getGlobalAlarms(config, definitions) {
    if (!config) throw new Error('Missing config argument');
    if (!definitions) throw new Error('Missing definitions argument');

    const alarms = union(config.alarms, config.global, config.function);

    return this.getAlarms(alarms, definitions);
  }

  getFunctionAlarms(functionObj, config, definitions) {
    if (!config) throw new Error('Missing config argument');
    if (!definitions) throw new Error('Missing definitions argument');

    const alarms = functionObj.alarms;
    return this.getAlarms(alarms, definitions);
  }

  getAlarmCloudFormation(alertTopics, definition, functionName, functionRef) {
    if (!functionRef) {
      return;
    }

    const okActions = [];
    const alarmActions = [];
    const insufficientDataActions = [];

    if (alertTopics.ok) {
      okActions.push(alertTopics.ok);
    }

    if (alertTopics.alarm) {
      alarmActions.push(alertTopics.alarm);
    }

    if (alertTopics.insufficientData) {
      insufficientDataActions.push(alertTopics.insufficientData);
    }

    if (definition.okActions) {
      definition.okActions.map((alertTopic) => {
        okActions.push(alertTopics[alertTopic].ok);
      });
    }

    if (definition.alarmActions) {
      definition.alarmActions.map((alertTopic) => {
        alarmActions.push(alertTopics[alertTopic].alarm);
      });
    }

    if (definition.insufficientDataActions) {
      definition.insufficientDataActions.map((alertTopic) => {
        insufficientDataActions.push(alertTopics[alertTopic].insufficientData);
      });
    }

    const stackName = this.awsProvider.naming.getStackName();

    const namespace = definition.pattern ? stackName : definition.namespace;

    const metricId = definition.pattern
      ? this.naming.getPatternMetricName(definition.metric, functionRef)
      : definition.metric;

    const dimensions = definition.pattern
      ? []
      : this.naming.getDimensionsList(
          definition.dimensions,
          functionRef,
          definition.omitDefaultDimension
        );

    const treatMissingData = definition.treatMissingData
      ? definition.treatMissingData
      : 'missing';

    const statisticValues = [
      'SampleCount',
      'Average',
      'Sum',
      'Minimum',
      'Maximum',
    ];
    let alarm;
    if (definition.type === 'static') {
      alarm = {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          ActionsEnabled: definition.actionsEnabled,
          Namespace: namespace,
          MetricName: metricId,
          AlarmDescription: definition.description,
          Threshold: definition.threshold,
          Period: definition.period,
          EvaluationPeriods: definition.evaluationPeriods,
          DatapointsToAlarm: definition.datapointsToAlarm,
          ComparisonOperator: definition.comparisonOperator,
          OKActions: okActions,
          AlarmActions: alarmActions,
          InsufficientDataActions: insufficientDataActions,
          Dimensions: dimensions,
          TreatMissingData: treatMissingData,
        },
      };

      if (statisticValues.includes(definition.statistic)) {
        alarm.Properties.Statistic = definition.statistic;
      } else {
        alarm.Properties.ExtendedStatistic = definition.statistic;
        alarm.Properties.EvaluateLowSampleCountPercentile =
          definition.evaluateLowSampleCountPercentile;
      }
    } else if (definition.type === 'anomalyDetection') {
      alarm = {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          ActionsEnabled: definition.actionsEnabled,
          AlarmDescription: definition.description,
          EvaluationPeriods: definition.evaluationPeriods,
          DatapointsToAlarm: definition.datapointsToAlarm,
          ComparisonOperator: definition.comparisonOperator,
          TreatMissingData: treatMissingData,
          OKActions: okActions,
          AlarmActions: alarmActions,
          InsufficientDataActions: insufficientDataActions,
          Metrics: [
            {
              Id: 'm1',
              ReturnData: true,
              MetricStat: {
                Metric: {
                  Namespace: namespace,
                  MetricName: metricId,
                  Dimensions: dimensions,
                },
                Period: definition.period,
                Stat: definition.statistic,
              },
            },
            {
              Id: 'ad1',
              Expression: `ANOMALY_DETECTION_BAND(m1, ${definition.threshold})`,
              Label: `${metricId} (expected)`,
              ReturnData: true,
            },
          ],
          ThresholdMetricId: 'ad1',
        },
      };
    } else if (definition.type === 'successRate') {
      alarm = {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          ActionsEnabled: definition.actionsEnabled,
          AlarmDescription: definition.description,
          EvaluationPeriods: definition.evaluationPeriods,
          DatapointsToAlarm: definition.datapointsToAlarm,
          ComparisonOperator: definition.comparisonOperator,
          TreatMissingData: treatMissingData,
          OKActions: okActions,
          AlarmActions: alarmActions,
          InsufficientDataActions: insufficientDataActions,
          Metrics: [
            {
              Id: 'errors',
              ReturnData: false,
              MetricStat: {
                Metric: {
                  Namespace: namespace || 'AWS/Lambda',
                  MetricName: 'Errors',
                  Dimensions: dimensions,
                },
                Period: definition.period,
                Stat: 'Sum',
              },
            },
            {
              Id: 'count',
              ReturnData: false,
              MetricStat: {
                Metric: {
                  Namespace: namespace || 'AWS/Lambda',
                  MetricName: 'Invocations',
                  Dimensions: dimensions,
                },
                Period: definition.period,
                Stat: 'Sum',
              },
            },
            {
              Id: 'successRate',
              Expression: `( 1 - (errors / count) ) * 100`,
              ReturnData: true,
            },
          ],
          Threshold: definition.threshold,
        },
      };
    } else {
      throw new Error(
        `Missing type for alarm ${definition.name} on function ${functionName}, must be one of 'static' or 'anomalyDetection'`
      );
    }

    if (definition.nameTemplate) {
      alarm.Properties.AlarmName = this.naming.getAlarmName({
        template: definition.nameTemplate,
        prefixTemplate: definition.prefixTemplate,
        functionLogicalId: functionRef,
        metricName: definition.metric,
        metricId,
        functionName,
        stackName,
      });
    } else if (definition.prefixTemplate) {
      alarm.Properties.AlarmName = this.naming.getAlarmName({
        template: '$[functionName]-$[metricName]',
        prefixTemplate: definition.prefixTemplate,
        functionLogicalId: functionRef,
        metricName: definition.name || definition.metric,
        metricId,
        functionName,
        stackName,
      });
    }

    return alarm;
  }

  getSnsTopicCloudFormation(topicName, notifications) {
    const subscription = (notifications || []).map((n) => ({
      Protocol: n.protocol,
      Endpoint: n.endpoint,
    }));

    return {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: topicName,
        Subscription: subscription,
      },
    };
  }

  _addAlertTopic(key, topics, alertTopics, customAlarmName) {
    const topicConfig = topics[key];
    const isTopicConfigAnObject = isObject(topicConfig);

    const topic = isTopicConfigAnObject ? topicConfig.topic : topicConfig;
    const isTopicAnObject = isObject(topic);

    const notifications = isTopicConfigAnObject
      ? topicConfig.notifications
      : [];

    if (topic) {
      if (isTopicAnObject || topic.indexOf('arn:') === 0) {
        if (customAlarmName) {
          alertTopics[customAlarmName] = alertTopics[customAlarmName] || {};
          alertTopics[customAlarmName][key] = topic;
        } else {
          alertTopics[key] = topic;
        }
      } else {
        const cfRef = `AwsAlerts${
          customAlarmName ? upperFirst(customAlarmName) : ''
        }${upperFirst(key)}`;
        if (customAlarmName) {
          if (!alertTopics[customAlarmName]) {
            alertTopics[customAlarmName] = {};
          }
          alertTopics[customAlarmName][key] = {
            Ref: cfRef,
          };
        } else {
          alertTopics[key] = {
            Ref: cfRef,
          };
        }

        this.addCfResources({
          [cfRef]: this.getSnsTopicCloudFormation(topic, notifications),
        });
      }
    }
  }

  compileAlertTopics(config) {
    const alertTopics = {};

    if (config.topics) {
      Object.keys(config.topics).forEach((key) => {
        if (['ok', 'alarm', 'insufficientData'].indexOf(key) !== -1) {
          this._addAlertTopic(key, config.topics, alertTopics);
        } else {
          Object.keys(config.topics[key]).forEach((subkey) => {
            this._addAlertTopic(subkey, config.topics[key], alertTopics, key);
          });
        }
      });
    }

    return alertTopics;
  }

  getLogMetricCloudFormation(
    alarm,
    functionName,
    normalizedFunctionName,
    functionObj
  ) {
    if (!alarm.pattern) return {};

    const logMetricCFRefBase = this.naming.getLogMetricCloudFormationRef(
      normalizedFunctionName,
      alarm.name
    );
    const logMetricCFRefALERT = `${logMetricCFRefBase}ALERT`;
    const logMetricCFRefOK = `${logMetricCFRefBase}OK`;

    const cfLogName = this.providerNaming.getLogGroupLogicalId(functionName);
    const metricNamespace = this.providerNaming.getStackName();
    const logGroupName = this.providerNaming.getLogGroupName(functionObj.name);
    const metricName = this.naming.getPatternMetricName(
      alarm.metric,
      normalizedFunctionName
    );

    return {
      [logMetricCFRefALERT]: {
        Type: 'AWS::Logs::MetricFilter',
        DependsOn: cfLogName,
        Properties: {
          FilterPattern: alarm.pattern,
          LogGroupName: logGroupName,
          MetricTransformations: [
            {
              MetricValue: 1,
              MetricNamespace: metricNamespace,
              MetricName: metricName,
            },
          ],
        },
      },
      [logMetricCFRefOK]: {
        Type: 'AWS::Logs::MetricFilter',
        DependsOn: cfLogName,
        Properties: {
          FilterPattern: '',
          LogGroupName: logGroupName,
          MetricTransformations: [
            {
              MetricValue: 0,
              MetricNamespace: metricNamespace,
              MetricName: metricName,
            },
          ],
        },
      },
    };
  }

  compileAlarms(config, definitions, alertTopics) {
    const globalAlarms = this.getGlobalAlarms(config, definitions);

    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName);

      const normalizedFunctionName =
        this.providerNaming.getLambdaLogicalId(functionName);

      const functionAlarms = this.getFunctionAlarms(
        functionObj,
        config,
        definitions
      );
      const alarms = globalAlarms.concat(functionAlarms).map((alarm) =>
        Object.assign(
          {
            nameTemplate: config.nameTemplate,
            prefixTemplate: config.prefixTemplate,
          },
          alarm
        )
      );

      const alarmStatements = alarms.reduce((statements, alarm) => {
        const key = this.naming.getAlarmCloudFormationRef(
          alarm.name,
          functionName
        );
        if (alarm.enabled) {
          const cf = this.getAlarmCloudFormation(
            alertTopics,
            alarm,
            functionName,
            normalizedFunctionName
          );

          statements[key] = cf;

          const logMetricCF = this.getLogMetricCloudFormation(
            alarm,
            functionName,
            normalizedFunctionName,
            functionObj
          );
          merge(statements, logMetricCF);
        } else {
          delete statements[key];
        }

        return statements;
      }, {});

      this.addCfResources(alarmStatements);
    });
  }

  getDashboardTemplates(configDashboards, stage) {
    const configType = typeof configDashboards;

    if (configType === 'boolean') {
      return ['default'];
    }
    if (configType === 'string') {
      return [configDashboards];
    }
    if (configType === 'object' && configDashboards.stages) {
      if (configDashboards.stages.indexOf(stage) >= 0) {
        if (configDashboards.templates) {
          return [].concat(configDashboards.templates);
        }
        return ['default'];
      }

      this.serverless.cli.log(
        `Info: Not deploying dashboards on stage ${this.options.stage}`
      );
      return [];
    }
    return [].concat(configDashboards);
  }

  compileDashboards(configDashboards) {
    const service = this.serverless.service;
    const provider = service.provider;
    const stage = this.options.stage;
    const region = this.options.region || provider.region;
    const dashboardTemplates = this.getDashboardTemplates(
      configDashboards,
      stage
    );

    const functions = this.serverless.service
      .getAllFunctions()
      .map((functionName) => ({ name: functionName }));

    const cf = [...new Set(dashboardTemplates)].reduce((acc, d) => {
      const dashboard = dashboards.createDashboard(
        service.service,
        stage,
        region,
        functions,
        d
      );

      const cfResource =
        d === 'default' ? 'AlertsDashboard' : `AlertsDashboard${d}`;
      const dashboardName =
        d === 'default'
          ? `${service.service}-${stage}-${region}`
          : `${service.service}-${stage}-${region}-${d}`;

      acc[cfResource] = {
        Type: 'AWS::CloudWatch::Dashboard',
        Properties: {
          DashboardName: dashboardName,
          DashboardBody: JSON.stringify(dashboard),
        },
      };
      return acc;
    }, {});
    this.addCfResources(cf);
  }

  _getCfResourceAndName(prefix, definitionName) {
    const service = this.serverless.service;
    const provider = service.provider;
    const stage = this.options.stage;
    const region = this.options.region || provider.region;
    const capitalDefinitionName = upperFirst(definitionName);
    return {
      cfResource: `Alerts${prefix}${capitalDefinitionName}`,
      cfName: `${service.service}-${stage}-${region}-${capitalDefinitionName}`,
    };
  }

  _getFilteredResourcesAsArray(resourcesKeys, resourceType, includeDisabled) {
    const resources =
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    return Object.keys(resources)
      .filter(
        (resource) =>
          resources[resource].Type === resourceType &&
          (includeDisabled ||
            resources[resource].Properties.enabled !== false) &&
          (!resourcesKeys ||
            resourcesKeys.length === 0 ||
            resourcesKeys.indexOf(resource) !== -1)
      )
      .map((key) => ({
        cfLogicalId: key,
        cfResource: resources[key],
      }));
  }

  _resolveAlarmsPhysicalLogicalIds(definition) {
    return this._getFilteredResourcesAsArray(
      definition.alarmsToInclude,
      'AWS::CloudWatch::Alarm',
      true
    ).map((filteredResource) => ({
      cfLogicalId: filteredResource.cfLogicalId,
      cfPhysicalId: filteredResource.cfResource.Properties.AlarmName,
    }));
  }

  _resolveAlarmRules(physicalLogicalIds) {
    const alarmRule = physicalLogicalIds
      .map((physicalLogicalId) => `ALARM(${physicalLogicalId.cfPhysicalId})`)
      .join(' OR ');

    return alarmRule;
  }

  _resolveAlarmActions(definition) {
    let alarmsActions = definition.alarmsActions;
    if (!alarmsActions?.length) {
      alarmsActions = ['AwsAlertsAlarm'];
    }

    const resourcesObj =
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    const resourcesCfNames = Object.keys(resourcesObj);

    const topicsToInclude = [];
    for (const alarmAction of alarmsActions) {
      if (resourcesCfNames.indexOf(alarmAction) !== -1) {
        const resource = resourcesObj[alarmAction];
        if (
          resource.Type === 'AWS::SNS::Topic' &&
          resource.Properties.enabled !== false
        ) {
          topicsToInclude.push({ Ref: alarmAction });
        }
      }
    }
    return topicsToInclude;
  }

  compileCompositeAlarms(config, definitions, alertTopics) {
    Object.keys(definitions).forEach((definitionName) => {
      const definition = definitions[definitionName];
      if (definition.type === 'composite' && definition.enabled !== false) {
        const physicalLogicalIds =
          this._resolveAlarmsPhysicalLogicalIds(definition);
        // only create the composite alarm if there is at least one alarm to include
        if (physicalLogicalIds?.length > 0) {
          const cf = {};
          const { cfResource, cfName } = this._getCfResourceAndName(
            'Composite',
            definitionName
          );
          const alarmActions = this._resolveAlarmActions(definition);
          const compositeAlarm = {
            Type: 'AWS::CloudWatch::CompositeAlarm',
            Properties: {
              AlarmName: cfName,
              AlarmDescription: definition.description,
              ActionsEnabled: definition.actionsEnabled,
              AlarmRule: this._resolveAlarmRules(physicalLogicalIds),
              AlarmActions: alarmActions,
            },
            DependsOn: physicalLogicalIds.map((alarm) => alarm.cfLogicalId),
          };

          cf[cfResource] = compositeAlarm;
          this.addCfResources(cf);
        }
      }
    });
  }

  compile() {
    const config = this.getConfig();
    if (!config) {
      // TODO warn no config
      return;
    }

    if (config.stages && !config.stages.includes(this.options.stage)) {
      this.serverless.cli.log(
        `Warning: Not deploying alerts on stage ${this.options.stage}`
      );
      return;
    }

    const definitions = this.getDefinitions(config);
    const alertTopics = this.compileAlertTopics(config);

    this.compileAlarms(config, definitions, alertTopics);

    this.compileCompositeAlarms(config, definitions, alertTopics);

    if (config.dashboards) {
      this.compileDashboards(config.dashboards);
    }
  }

  addCfResources(resources) {
    if (this.externalStack.isUsingExternalStack()) {
      // If we're using an external CloudFormation stack, merge the resources there.
      this.externalStack.mergeResources(resources);
    } else {
      // Otherwise merge the resources to the main Serverless stack.
      merge(
        this.serverless.service.provider.compiledCloudFormationTemplate
          .Resources,
        resources
      );
    }
  }
}

module.exports = AlertsPlugin;
