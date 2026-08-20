import React from 'react';
import { Button, Empty } from 'antd';
import styled from 'styled-components';
import { DragDropContext, Draggable, Droppable, DropResult } from 'react-beautiful-dnd';
import {
  DownOutlined,
  DragOutlined,
  PrimaryKeyFontAwesomeIcon,
  RightOutlined,
} from '../../shared/icons/FontAwesomeIcons';
import { ConfirmPopover } from '../../components/ConfirmPopover';

const SortableList = styled.div`
  overflow: hidden;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  background: #fff;
`;

const SortableItem = styled.div<{ $isDragging?: boolean }>`
  background: #fff;
  border-bottom: 1px solid #d9d9d9;
  box-shadow: ${({ $isDragging }) => ($isDragging ? '0 6px 18px rgba(0, 0, 0, 0.16)' : 'none')};

  &:last-child {
    border-bottom: 0;
  }
`;

const SortableItemHeader = styled.div<{ $dropTarget?: boolean }>`
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-height: 38px;
  padding: 7px 12px;
  line-height: 24px;
  cursor: pointer;
  background: ${({ $dropTarget }) => ($dropTarget ? '#f0edff' : '#fafafa')};
  transition: background 0.15s ease;
`;

const PrimaryKeyItemHeader = styled(SortableItemHeader)`
  background: #fffbe6;

  &:hover {
    background: #fff1b8;
  }
`;

const SortableItemArrow = styled.span`
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  color: rgba(0, 0, 0, 0.45);
  font-size: 11px;
`;

const SortableItemTitle = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SortableItemActions = styled.span`
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  margin-left: auto;
`;

const SortableItemBody = styled.div`
  padding: 16px;
  border-top: 1px solid #f0f0f0;
  background: #fff;
`;

const DragHandle = styled.span`
  display: inline-flex;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
  margin-right: 8px;
  color: rgba(0, 0, 0, 0.4);
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
`;

export type SchemaItemListProps = {
  section: string;
  items: Record<string, any>[];
  expandedKeys: string[];
  droppableId: string;
  emptyDescription: string;
  getItemKey: (item: Record<string, any>, index: number) => string;
  getItemTitle: (item: Record<string, any>) => string;
  isPrimaryKey?: (item: Record<string, any>) => boolean;
  onToggle: (index: number) => void;
  onRemove: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  renderItemForm: (item: Record<string, any>, index: number) => React.ReactNode;
};

export function SchemaItemList({
  section,
  items,
  expandedKeys,
  droppableId,
  emptyDescription,
  getItemKey,
  getItemTitle,
  isPrimaryKey = () => false,
  onToggle,
  onRemove,
  onReorder,
  renderItemForm,
}: SchemaItemListProps) {
  function handleDragEnd(result: DropResult) {
    if (!result.destination || result.destination.index === result.source.index) return;
    onReorder(result.source.index, result.destination.index);
  }

  if (items.length === 0) {
    return <Empty description={emptyDescription} />;
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId={droppableId}>
        {(droppableProvided) => (
          <SortableList ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
            {items.map((item, index) => {
              const itemKey = getItemKey(item, index);
              const expanded = expandedKeys.includes(String(index));
              const primaryKey = isPrimaryKey(item);
              const Header = primaryKey ? PrimaryKeyItemHeader : SortableItemHeader;

              return (
                <Draggable key={itemKey} draggableId={itemKey} index={index}>
                  {(draggableProvided, snapshot) => (
                    <SortableItem
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      className={`visual-editor-sortable-item visual-editor-item-${section}-${index}`}
                      $isDragging={snapshot.isDragging}
                    >
                      <Header
                        $dropTarget={snapshot.isDragging}
                        aria-expanded={expanded}
                        onClick={() => onToggle(index)}
                      >
                        <DragHandle
                          {...draggableProvided.dragHandleProps}
                          title="Arraste para reordenar"
                          aria-label="Arraste para reordenar"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DragOutlined />
                        </DragHandle>
                        <SortableItemArrow>{expanded ? <DownOutlined /> : <RightOutlined />}</SortableItemArrow>
                        <SortableItemTitle>
                          {getItemTitle(item) || '(sem nome)'}
                          {primaryKey ? (
                            <span style={{ marginLeft: 6, color: '#ad6800' }} title="Chave primária">
                              <PrimaryKeyFontAwesomeIcon style={{ fontSize: 12 }} />
                            </span>
                          ) : null}
                        </SortableItemTitle>
                        <SortableItemActions>
                          <ConfirmPopover
                            title="Remover este item?"
                            onConfirm={() => onRemove(index)}
                          >
                            <Button danger size="small" onClick={(event) => event.stopPropagation()}>Remover</Button>
                          </ConfirmPopover>
                        </SortableItemActions>
                      </Header>
                      {expanded ? <SortableItemBody>{renderItemForm(item, index)}</SortableItemBody> : null}
                    </SortableItem>
                  )}
                </Draggable>
              );
            })}
            {droppableProvided.placeholder}
          </SortableList>
        )}
      </Droppable>
    </DragDropContext>
  );
}
