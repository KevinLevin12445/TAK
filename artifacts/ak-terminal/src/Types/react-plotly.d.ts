declare module 'react-plotly.js' {
  import { Component } from 'react';
  
  interface PlotProps {
    data: any[];
    layout?: any;
    config?: any;
    onInitialized?: (figure: any, graphDiv: any) => void;
    onUpdate?: (figure: any, graphDiv: any) => void;
    onPurge?: (graphDiv: any) => void;
    onError?: (err: any) => void;
    divId?: string;
    className?: string;
    style?: React.CSSProperties;
  }
  
  export default class Plot extends Component<PlotProps> {}
}
