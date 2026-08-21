import { Component, Input, OnInit, OnChanges, ElementRef, ViewChild, SimpleChanges, AfterViewInit, ChangeDetectionStrategy } from '@angular/core';

import mermaid from 'mermaid';

/**
 * Reusable Mermaid diagram component.
 * Renders mermaid diagrams with a collapsible panel.
 */
@Component({
  selector: 'app-mermaid-diagram',
  standalone: true,
  imports: [],
  template: `
    <div class="diagram-container" [class.expanded]="isExpanded">
      <button class="toggle-btn" (click)="toggleDiagram()">
        <span class="toggle-icon">{{ isExpanded ? '▼' : '▶' }}</span>
        <span class="toggle-text">📊 {{ title }}</span>
      </button>
    
      @if (isExpanded) {
        <div class="diagram-content">
          <div class="diagram-tabs">
            @for (tab of tabs; track tab) {
              <button
                class="tab-btn"
                [class.active]="activeTab === tab.id"
                (click)="setActiveTab(tab.id)">
                {{ tab.label }}
              </button>
            }
          </div>
          <div class="diagram-wrapper">
            <div #mermaidContainer class="mermaid-container"></div>
          </div>
        </div>
      }
    </div>
    `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .diagram-container {
      margin-top: 16px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: white;
      overflow: hidden;
    }
    
    .toggle-btn {
      width: 100%;
      padding: 12px 16px;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 600;
      color: #334155;
      transition: background 0.2s;
    }
    
    .toggle-btn:hover {
      background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
    }
    
    .toggle-icon {
      font-size: 12px;
      color: #64748b;
    }
    
    .diagram-content {
      border-top: 1px solid #e2e8f0;
    }
    
    .diagram-tabs {
      display: flex;
      gap: 0;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }
    
    .tab-btn {
      padding: 10px 20px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 13px;
      color: #64748b;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    
    .tab-btn:hover {
      color: #334155;
      background: #f1f5f9;
    }
    
    .tab-btn.active {
      color: #dc382d;
      border-bottom-color: #dc382d;
      background: white;
    }
    
    .diagram-wrapper {
      padding: 20px;
      overflow-x: auto;
      background: white;
    }
    
    .mermaid-container {
      display: flex;
      justify-content: center;
      min-height: 200px;
    }
    
    .mermaid-container :global(svg) {
      max-width: 100%;
      height: auto;
    }
  `]
})
export class MermaidDiagramComponent implements OnInit, OnChanges, AfterViewInit {
  @Input() title = 'Architecture Diagram';
  @Input() architectureDiagram = '';
  @Input() sequenceDiagram = '';
  
  @ViewChild('mermaidContainer') mermaidContainer!: ElementRef;
  
  isExpanded = false;
  activeTab: 'architecture' | 'sequence' = 'architecture';
  
  tabs = [
    { id: 'architecture' as const, label: '🏗️ Architecture' },
    { id: 'sequence' as const, label: '📋 Sequence' }
  ];
  
  private initialized = false;
  
  ngOnInit(): void {
    // 'antiscript' (not 'loose'): mermaid still runs the rendered SVG through
    // DOMPurify and strips <script>, so the `innerHTML = svg` sink is sanitized,
    // while HTML labels (<br/>, &nbsp;) used throughout the diagrams keep working.
    // 'strict' would force htmlLabels off and break those labels. Inputs are
    // static developer-authored constants today; this is defense-in-depth in case
    // a diagram ever becomes dynamic.
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'antiscript',
      flowchart: { useMaxWidth: true, htmlLabels: true },
      sequence: { useMaxWidth: true }
    });
  }
  
  ngAfterViewInit(): void {
    this.initialized = true;
    if (this.isExpanded) {
      this.renderDiagram();
    }
  }
  
  ngOnChanges(changes: SimpleChanges): void {
    if (this.initialized && this.isExpanded && 
        (changes['architectureDiagram'] || changes['sequenceDiagram'])) {
      this.renderDiagram();
    }
  }
  
  toggleDiagram(): void {
    this.isExpanded = !this.isExpanded;
    if (this.isExpanded && this.initialized) {
      setTimeout(() => this.renderDiagram(), 50);
    }
  }
  
  setActiveTab(tab: 'architecture' | 'sequence'): void {
    this.activeTab = tab;
    this.renderDiagram();
  }
  
  private async renderDiagram(): Promise<void> {
    if (!this.mermaidContainer?.nativeElement) return;
    
    const diagram = this.activeTab === 'architecture' 
      ? this.architectureDiagram 
      : this.sequenceDiagram;
    
    if (!diagram) return;
    
    try {
      const container = this.mermaidContainer.nativeElement;
      const id = `mermaid-${Date.now()}`;
      const { svg } = await mermaid.render(id, diagram);
      container.innerHTML = svg;
    } catch (error) {
      console.error('Mermaid rendering error:', error);
      this.mermaidContainer.nativeElement.innerHTML = 
        '<p style="color: #dc2626;">Error rendering diagram</p>';
    }
  }
}

